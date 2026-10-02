"use strict";

parserFactory.register("fucknovelpia.com", () => new FucknovelpiaParser());

class FucknovelpiaParser extends Parser {
    constructor() {
        super();
        // site enforces a real rate limit server-side (confirmed: returns 429
        // "slow down" past a certain request rate), on top of its own
        // client-side "anti-bot" navigation warning. Keep requests slow.
        this.minimumThrottle = 3000;
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
