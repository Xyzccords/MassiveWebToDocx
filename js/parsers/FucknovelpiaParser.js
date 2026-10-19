"use strict";

parserFactory.register("fucknovelpia.com", () => new FucknovelpiaParser());

class FucknovelpiaParser extends Parser {
    constructor() {
        super();
        // site enforces a real rate limit server-side (confirmed: returns 429
        // "slow down" past a certain request rate), on top of its own
        // client-side "anti-bot" navigation warning. 3s/chapter still hit the
        // wall past ~40 chapters and stayed 429 through the full built-in
        // backoff ladder (120+60+30+15s), so the limit is a rolling window,
        // not just requests-per-second. Start slower, and back off further
        // on our own if it happens again (see fetchChapter below).
        this.minimumThrottle = 8000;
    }

    // Instead of a bare fetch() straight to chapter.php (which looks exactly like a
    // scraper: no CSS/JS/images alongside it, referrer of chrome-extension://...),
    // load the chapter in a real background tab, same as a human clicking into it
    // would. It's still one request to chapter.php, but it's a real navigation with
    // the normal page requests, cookies and referer chain riding along with it.
    async fetchChapter(url) {
        try {
            let html = await FucknovelpiaParser.fetchChapterViaTab(url);
            let dom = new DOMParser().parseFromString(html, "text/html");
            util.setBaseTag(url, dom);
            return dom;
        } catch (error) {
            // site still 429'd us after the built-in retry ladder is exhausted:
            // slow all future chapters down for the rest of this run instead of
            // just failing again on the next retry.
            this.minimumThrottle = Math.min(this.minimumThrottle * 2, 60000);
            throw error;
        }
    }

    static async fetchChapterViaTab(url) {
        let tabId = await util.createChapterTab(url);
        try {
            await FucknovelpiaParser.waitForTabLoad(tabId);
            let results = await chrome.scripting.executeScript({
                target: {tabId: tabId},
                func: () => document.documentElement.outerHTML
            });
            return results[0].result;
        } finally {
            await new Promise(resolve => chrome.tabs.remove(tabId, resolve));
        }
    }

    static waitForTabLoad(tabId) {
        return new Promise((resolve) => {
            let done = false;
            let timeoutId = setTimeout(finish, 20000);
            function finish() {
                if (!done) {
                    done = true;
                    clearTimeout(timeoutId);
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            }
            function listener(updatedTabId, changeInfo) {
                if (updatedTabId === tabId && changeInfo.status === "complete") {
                    finish();
                }
            }
            chrome.tabs.onUpdated.addListener(listener);
        });
    }

    // chapter list is already fully rendered server-side on the novel page,
    // no secondary AJAX call needed (unlike wenku8/novelpia).
    getChapterUrls(dom) {
        let list = dom.querySelector("#chapter-list");
        if (list == null) {
            return [];
        }
        return [...list.querySelectorAll("li a")].map(a => ({
            sourceUrl: a.href,
            title: (a.querySelector(".chapter-item-main") ?? a).textContent.trim()
        }));
    }

    findContent(dom) {
        return dom.querySelector(".reader");
    }

    findChapterTitle(dom) {
        return dom.querySelector(".chapter-title");
    }

    extractTitleImpl(dom) {
        return dom.querySelector(".hero-title");
    }

    extractAuthor(dom) {
        let li = [...dom.querySelectorAll(".info-list li")]
            .find(li => li.querySelector("strong")?.textContent.trim() === "Author:");
        return li ? li.textContent.replace("Author:", "").trim() : super.extractAuthor(dom);
    }

    extractLanguage(dom) {
        return dom.querySelector("html").getAttribute("lang") ?? "en";
    }

    extractSubject(dom) {
        let genres = [...dom.querySelectorAll(".genres .genre-pill")].map(e => e.textContent.trim());
        let tags = [...dom.querySelectorAll(".tags .tag-pill")].map(e => e.textContent.trim());
        return genres.concat(tags).join(", ");
    }

    extractDescription(dom) {
        return dom.querySelector(".description-box .description")?.textContent.trim() ?? super.extractDescription(dom);
    }

    findCoverImageUrl(dom) {
        return dom.querySelector("meta[property=\"og:image\"]")?.getAttribute("content") ?? null;
    }
}
