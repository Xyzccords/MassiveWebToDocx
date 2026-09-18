"use strict";

parserFactory.register("wenku8.net", () => new Wenku8Parser());

class Wenku8Parser extends Parser {
    constructor() {
        super();
    }

    // wenku8.net is behind Cloudflare and rejects requests without a Referer
    // pointing at itself, same trick used for other sites in this extension.
    setRefererOnWebRequests = (() => {
        let done = false;

        return async () => {
            if (done) {
                return;
            }
            done = true;

            const fetchRules = [
                {
                    "id": 1,
                    "priority": 1,
                    "condition": {
                        "urlFilter": "wenku8.net",
                    },
                    "action": {
                        "type": "modifyHeaders",
                        "requestHeaders": [
                            {
                                "header": "Referer",
                                "operation": "set",
                                "value": "https://www.wenku8.net/"
                            },
                        ]
                    }
                }
            ];

            await HttpClient.setDeclarativeNetRequestRules(fetchRules);
        };
    })();

    async getChapterUrls(dom) {
        await this.setRefererOnWebRequests();
        let id = Wenku8Parser.extractBookId(dom);
        let tocUrl = `https://www.wenku8.net/modules/article/reader.php?aid=${id}`;
        let xhr = await HttpClient.wrapFetch(tocUrl, this.makeOptions());
        let menu = xhr.responseXML.querySelector("table");
        return util.hyperlinksToChapterList(menu);
    }

    static extractBookId(dom) {
        let path = new URL(dom.baseURI).pathname.split("/");
        return path[path.length - 1].split(".")[0];
    }

    findContent(dom) {
        return dom.querySelector("#contentmain");
    }

    extractTitleImpl(dom) {
        return dom.querySelector("tbody td b").textContent;
    }

    extractLanguage() {
        return "zh";
    }

    removeUnwantedElementsFromContentElement(element) {
        util.removeChildElementsMatchingSelector(element, "ul#contentdp");
        super.removeUnwantedElementsFromContentElement(element);
    }

    findCoverImageUrl(dom) {
        return util.getFirstImgSrc(dom, "div#content");
    }

    fetchChapter(url) {
        // site does not tell us GBK is used to encode text
        return HttpClient.wrapFetch(url, this.makeOptions()).then(function(xhr) {
            return Promise.resolve(xhr.responseXML);
        });
    }

    makeOptions() {
        return ({
            makeTextDecoder: () => new TextDecoder("GBK")
        });
    }
}
