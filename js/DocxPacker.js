/*
    Packs the same content that EpubPacker would pack into an EPUB, into a
    real .docx (Word / OOXML WordprocessingML) file instead.

    A .docx is a zip, same as an .epub, just with a different set of XML
    parts inside (word/document.xml instead of an OPF/NCX/XHTML tree). We
    reuse zip.js (already loaded for the EPUB path) to build it.

    Scope/known limitations (kept deliberately simple):
    - Tables are flattened to one paragraph per row (cells tab-separated).
    - Lists (<ul>/<ol>) become paragraphs with a literal "•"/"N." prefix,
      not real Word numbering.
    - Internal cross-chapter links (footnotes, "back to top", etc.) render
      as plain text; only external http(s) links become clickable.
    - image/svg+xml and image/webp images are not embeddable reliably in
      Word, so they're replaced with a small text placeholder.
    - The table of contents is a Word TOC field built from Heading1/2
      paragraphs; Word needs the user to accept "update fields" the first
      time the document is opened (standard Word behaviour, driven by
      word/settings.xml below) to fill it in and compute page numbers.
*/
"use strict";

class DocxPacker {
    constructor(metaInfo) {
        this.metaInfo = metaInfo;
        this.relationships = [];
        this.nextRelId = 3; // rId1 = styles.xml, rId2 = settings.xml
        this.mediaFiles = [];
        this.mediaIndex = 0;
        this.contentTypeExtensions = new Map();
        this.imageInfoByHref = new Map(); // href (as used in <img src>) -> {relId, width, height}
        this.nextDrawingId = 1;
    }

    static addExtensionIfMissing(fileName) {
        let extension = ".docx";
        return (fileName.endsWith(extension)) ? fileName : fileName + extension;
    }

    assemble(epubItemSupplier) {
        this.indexImages(epubItemSupplier);
        let bodyXml = this.buildBodyXml(epubItemSupplier);

        let zipFileWriter = new zip.BlobWriter("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        let zipWriter = new zip.ZipWriter(zipFileWriter, {useWebWorkers: false, compressionMethod: 8, extendedTimestamp: false});

        zipWriter.add("[Content_Types].xml", new zip.TextReader(this.buildContentTypesXml()));
        zipWriter.add("_rels/.rels", new zip.TextReader(DocxPacker.PACKAGE_RELS_XML));
        zipWriter.add("docProps/core.xml", new zip.TextReader(this.buildCoreXml()));
        zipWriter.add("docProps/app.xml", new zip.TextReader(DocxPacker.APP_XML));
        zipWriter.add("word/settings.xml", new zip.TextReader(DocxPacker.SETTINGS_XML));
        zipWriter.add("word/styles.xml", new zip.TextReader(DocxPacker.STYLES_XML));
        zipWriter.add("word/document.xml", new zip.TextReader(this.buildDocumentXml(bodyXml)));
        zipWriter.add("word/_rels/document.xml.rels", new zip.TextReader(this.buildDocumentRelsXml()));
        for (let media of this.mediaFiles) {
            zipWriter.add("word/media/" + media.name, new zip.BlobReader(new Blob([media.arraybuffer])));
        }
        return zipWriter.close();
    }

    //======================================================================
    // image indexing (shared across all chapters)
    //======================================================================

    indexImages(epubItemSupplier) {
        if (main.getUserPreferences().skipImages.value) {
            return; // "Skip Images" ticked: don't embed anything, including the cover
        }
        for (let item of epubItemSupplier.manifestItems()) {
            if (item.arraybuffer == null) {
                continue; // not an image (e.g. it's a chapter)
            }
            let href = util.makeRelative(item.getZipHref());
            let typeInfo = DocxPacker.IMAGE_TYPE_TABLE[item.getMediaType()];
            if (typeInfo === undefined) {
                continue; // unsupported format (svg, webp, ...): leave out of the map -> placeholder text used instead
            }
            this.mediaIndex++;
            let mediaName = "image" + this.mediaIndex + "." + typeInfo.ext;
            let relId = "rId" + (this.nextRelId++);
            this.relationships.push({
                id: relId,
                type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
                target: "media/" + mediaName
            });
            this.mediaFiles.push({name: mediaName, arraybuffer: item.arraybuffer});
            this.contentTypeExtensions.set(typeInfo.ext, typeInfo.contentType);
            this.imageInfoByHref.set(href, {relId, width: item.width, height: item.height});
        }
    }

    addHyperlinkRelationship(url) {
        let relId = "rId" + (this.nextRelId++);
        this.relationships.push({
            id: relId,
            type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
            target: url,
            targetMode: "External"
        });
        return relId;
    }

    //======================================================================
    // word/document.xml body
    //======================================================================

    buildBodyXml(epubItemSupplier) {
        let userPreferences = main.getUserPreferences();
        let parts = [];
        if (!userPreferences.skipImages.value && epubItemSupplier.hasCoverImageFile()) {
            parts.push(this.buildCoverPageXml(epubItemSupplier.coverImageInfo));
        }
        if (userPreferences.addInformationPage.value) {
            parts.push(DocxPacker.buildTocPageXml(this.metaInfo.title));
        }

        let isFirstChapter = true;
        for (let chapter of epubItemSupplier.spineItems()) {
            if (!isFirstChapter) {
                parts.push(DocxPacker.PAGE_BREAK_PARAGRAPH_XML);
            }
            isFirstChapter = false;
            if (chapter.newArc) {
                parts.push(this.makeParagraph([this.makeTextRun(chapter.newArc, {})], "Heading1"));
            }
            parts.push(this.convertChapterNodes(chapter.nodes || []));
        }
        parts.push(DocxPacker.buildSectPrXml());
        return parts.join("");
    }

    buildCoverPageXml(coverImageInfo) {
        let href = util.makeRelative(coverImageInfo.getZipHref());
        let imageXml = this.buildImageRunXml(href);
        return this.makeParagraph([imageXml], null, {alignment: "center"}) + DocxPacker.PAGE_BREAK_PARAGRAPH_XML;
    }

    static buildTocPageXml(title) {
        let titlePara = `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">${DocxPacker.escapeXml(title || "")}</w:t></w:r></w:p>`;
        let tocHeading = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Índice</w:t></w:r></w:p>`;
        let tocField =
            "<w:p><w:r><w:fldChar w:fldCharType=\"begin\"/></w:r>" +
            "<w:r><w:instrText xml:space=\"preserve\"> TOC \\o \"1-2\" \\h \\z \\u </w:instrText></w:r>" +
            "<w:r><w:fldChar w:fldCharType=\"separate\"/></w:r>" +
            "<w:r><w:t>Haz clic derecho aquí y elige \"Actualizar campos\" para generar el índice.</w:t></w:r>" +
            "<w:r><w:fldChar w:fldCharType=\"end\"/></w:r></w:p>";
        return titlePara + tocHeading + tocField + DocxPacker.PAGE_BREAK_PARAGRAPH_XML;
    }

    convertChapterNodes(nodes) {
        let paragraphs = [];
        for (let node of nodes) {
            this.convertBlockNode(node, paragraphs);
        }
        return paragraphs.join("");
    }

    //======================================================================
    // block-level conversion: DOM node(s) -> one or more <w:p> paragraphs
    //======================================================================

    convertBlockNode(node, paragraphs) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (!util.isStringWhiteSpace(node.textContent)) {
                paragraphs.push(this.makeParagraph([this.makeTextRun(node.textContent, {})]));
            }
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
            return;
        }

        let tagName = node.tagName.toLowerCase();
        let headingLevel = DocxPacker.HEADING_TAGS[tagName];
        if (headingLevel !== undefined) {
            paragraphs.push(this.makeParagraph(this.collectInlineRuns(node, {}), "Heading" + headingLevel));
        } else if (tagName === "hr") {
            paragraphs.push(DocxPacker.HORIZONTAL_RULE_PARAGRAPH_XML);
        } else if (tagName === "ul" || tagName === "ol") {
            this.convertListNode(node, tagName === "ol", paragraphs);
        } else if (tagName === "table") {
            this.convertTableNode(node, paragraphs);
        } else if (tagName === "div" || tagName === "figure" || tagName === "section") {
            if (DocxPacker.containsBlockChild(node)) {
                for (let child of Array.from(node.childNodes)) {
                    this.convertBlockNode(child, paragraphs);
                }
            } else {
                paragraphs.push(this.makeParagraph(this.collectInlineRuns(node, {})));
            }
        } else {
            // p, blockquote, li (stray), figcaption, or anything else: one paragraph
            let style = (tagName === "blockquote") ? "Quote" : null;
            paragraphs.push(this.makeParagraph(this.collectInlineRuns(node, {}), style));
        }
    }

    static containsBlockChild(element) {
        return [...element.children].some(child => DocxPacker.BLOCK_TAG_SET.has(child.tagName.toLowerCase()));
    }

    convertListNode(listNode, isOrdered, paragraphs) {
        let index = 0;
        for (let li of [...listNode.children].filter(c => c.tagName.toLowerCase() === "li")) {
            index++;
            let prefix = isOrdered ? (index + ". ") : "•  ";
            let runs = [this.makeTextRun(prefix, {})].concat(this.collectInlineRuns(li, {}));
            paragraphs.push(this.makeParagraph(runs, "ListParagraph"));
        }
    }

    convertTableNode(tableNode, paragraphs) {
        for (let row of [...tableNode.querySelectorAll("tr")]) {
            let cells = [...row.querySelectorAll("td, th")];
            let runs = [];
            cells.forEach((cell, i) => {
                if (i !== 0) {
                    runs.push("<w:r><w:tab/></w:r>");
                }
                runs = runs.concat(this.collectInlineRuns(cell, {}));
            });
            if (runs.length !== 0) {
                paragraphs.push(this.makeParagraph(runs));
            }
        }
    }

    //======================================================================
    // inline-level conversion: DOM node -> array of <w:r> run XML strings
    //======================================================================

    collectInlineRuns(node, formatting) {
        let runs = [];
        for (let child of Array.from(node.childNodes)) {
            this.collectInlineRunsForNode(child, formatting, runs);
        }
        return runs;
    }

    collectInlineRunsForNode(node, formatting, runs) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (node.textContent.length !== 0) {
                runs.push(this.makeTextRun(node.textContent, formatting));
            }
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
            return;
        }

        let tagName = node.tagName.toLowerCase();
        switch (tagName) {
            case "br":
                runs.push("<w:r><w:br/></w:r>");
                break;
            case "img":
                runs.push(this.buildImageRunXml(node.getAttribute("src")));
                break;
            case "b": case "strong":
                runs.push(...this.collectInlineRuns(node, {...formatting, bold: true}));
                break;
            case "i": case "em":
                runs.push(...this.collectInlineRuns(node, {...formatting, italic: true}));
                break;
            case "u":
                runs.push(...this.collectInlineRuns(node, {...formatting, underline: true}));
                break;
            case "s": case "strike": case "del":
                runs.push(...this.collectInlineRuns(node, {...formatting, strike: true}));
                break;
            case "sup":
                runs.push(...this.collectInlineRuns(node, {...formatting, vertAlign: "superscript"}));
                break;
            case "sub":
                runs.push(...this.collectInlineRuns(node, {...formatting, vertAlign: "subscript"}));
                break;
            case "a":
                this.collectHyperlinkRuns(node, formatting, runs);
                break;
            default:
                // span and any other/unknown inline (or stray block) tag: pass through
                runs.push(...this.collectInlineRuns(node, formatting));
        }
    }

    collectHyperlinkRuns(anchorNode, formatting, runs) {
        let href = anchorNode.getAttribute("href") || "";
        let isExternal = /^https?:\/\//i.test(href);
        let innerRuns = this.collectInlineRuns(anchorNode, {...formatting, hyperlink: isExternal});
        if (isExternal) {
            let relId = this.addHyperlinkRelationship(href);
            runs.push(`<w:hyperlink r:id="${relId}">${innerRuns.join("")}</w:hyperlink>`);
        } else {
            runs.push(...innerRuns);
        }
    }

    buildImageRunXml(href) {
        let info = href ? this.imageInfoByHref.get(href) : undefined;
        if (info === undefined) {
            return this.makeTextRun("[imagen no incluida]", {italic: true});
        }
        let {widthEmu, heightEmu} = DocxPacker.computeImageEmuSize(info.width, info.height);
        let id = this.nextDrawingId++;
        return "<w:r><w:drawing>" +
            `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
            `<wp:extent cx="${widthEmu}" cy="${heightEmu}"/>` +
            `<wp:docPr id="${id}" name="Picture ${id}"/>` +
            `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
            `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
            `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
            `<pic:blipFill><a:blip r:embed="${info.relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
            `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm>` +
            `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
            `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    }

    static computeImageEmuSize(width, height) {
        width = width || 300;
        height = height || 400;
        let widthEmu = width * DocxPacker.EMU_PER_PX;
        let heightEmu = height * DocxPacker.EMU_PER_PX;
        if (widthEmu > DocxPacker.MAX_IMAGE_WIDTH_EMU) {
            let scale = DocxPacker.MAX_IMAGE_WIDTH_EMU / widthEmu;
            widthEmu = DocxPacker.MAX_IMAGE_WIDTH_EMU;
            heightEmu = Math.round(heightEmu * scale);
        }
        return {widthEmu, heightEmu};
    }

    //======================================================================
    // low level XML builders
    //======================================================================

    makeParagraph(runsOrXml, style, options) {
        let pPr = "";
        if (style || (options && options.alignment)) {
            let styleXml = style ? `<w:pStyle w:val="${style}"/>` : "";
            let alignXml = (options && options.alignment) ? `<w:jc w:val="${options.alignment}"/>` : "";
            pPr = `<w:pPr>${styleXml}${alignXml}</w:pPr>`;
        }
        return `<w:p>${pPr}${runsOrXml.join("")}</w:p>`;
    }

    makeTextRun(text, formatting) {
        let rPr = DocxPacker.buildRunPropertiesXml(formatting);
        return `<w:r>${rPr}<w:t xml:space="preserve">${DocxPacker.escapeXml(text)}</w:t></w:r>`;
    }

    static buildRunPropertiesXml(formatting) {
        let parts = [];
        if (formatting.hyperlink) {
            parts.push("<w:rStyle w:val=\"Hyperlink\"/>");
        }
        if (formatting.bold) {
            parts.push("<w:b/>");
        }
        if (formatting.italic) {
            parts.push("<w:i/>");
        }
        if (formatting.underline) {
            parts.push("<w:u w:val=\"single\"/>");
        }
        if (formatting.strike) {
            parts.push("<w:strike/>");
        }
        if (formatting.vertAlign) {
            parts.push(`<w:vertAlign w:val="${formatting.vertAlign}"/>`);
        }
        return (parts.length === 0) ? "" : `<w:rPr>${parts.join("")}</w:rPr>`;
    }

    static makeHeadingStyleXml(level, halfPoints) {
        return `<w:style w:type="paragraph" w:styleId="Heading${level}">` +
            `<w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
            `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
            `<w:rPr><w:b/><w:sz w:val="${halfPoints}"/><w:szCs w:val="${halfPoints}"/></w:rPr></w:style>`;
    }

    static escapeXml(text) {
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    //======================================================================
    // document.xml / rels / content-types / metadata
    //======================================================================

    buildDocumentXml(bodyXml) {
        return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
            "<w:document " +
            "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" " +
            "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" " +
            "xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" " +
            "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" " +
            "xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">" +
            `<w:body>${bodyXml}</w:body></w:document>`;
    }

    static buildSectPrXml() {
        return "<w:sectPr>" +
            "<w:pgSz w:w=\"11906\" w:h=\"16838\"/>" +
            "<w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"708\" w:footer=\"708\" w:gutter=\"0\"/>" +
            "</w:sectPr>";
    }

    buildDocumentRelsXml() {
        let entries = [
            {id: "rId1", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles", target: "styles.xml"},
            {id: "rId2", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings", target: "settings.xml"}
        ].concat(this.relationships);

        let rels = entries.map(r => {
            let targetMode = r.targetMode ? ` TargetMode="${r.targetMode}"` : "";
            return `<Relationship Id="${r.id}" Type="${r.type}" Target="${DocxPacker.escapeXml(r.target)}"${targetMode}/>`;
        }).join("");

        return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
            rels + "</Relationships>";
    }

    buildContentTypesXml() {
        let imageDefaults = [...this.contentTypeExtensions.entries()]
            .map(([ext, contentType]) => `<Default Extension="${ext}" ContentType="${contentType}"/>`)
            .join("");

        return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
            "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">" +
            "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>" +
            "<Default Extension=\"xml\" ContentType=\"application/xml\"/>" +
            imageDefaults +
            "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>" +
            "<Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>" +
            "<Override PartName=\"/word/settings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml\"/>" +
            "<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>" +
            "<Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>" +
            "</Types>";
    }

    buildCoreXml() {
        let isoDate = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
            "<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" " +
            "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" " +
            "xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">" +
            `<dc:title>${DocxPacker.escapeXml(this.metaInfo.title || "")}</dc:title>` +
            `<dc:creator>${DocxPacker.escapeXml(this.metaInfo.author || "")}</dc:creator>` +
            `<dc:language>${DocxPacker.escapeXml(this.metaInfo.language || "en")}</dc:language>` +
            `<dc:description>${DocxPacker.escapeXml(this.metaInfo.description || "")}</dc:description>` +
            `<dcterms:created xsi:type="dcterms:W3CDTF">${isoDate}</dcterms:created>` +
            `<dcterms:modified xsi:type="dcterms:W3CDTF">${isoDate}</dcterms:modified>` +
            "</cp:coreProperties>";
    }
}

DocxPacker.EMU_PER_PX = 9525;
DocxPacker.MAX_IMAGE_WIDTH_EMU = 5943600; // 6.5in content width at 1in margins on A4/Letter

DocxPacker.HEADING_TAGS = {h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6};
DocxPacker.BLOCK_TAG_SET = new Set(["p", "div", "blockquote", "ul", "ol", "li", "table",
    "h1", "h2", "h3", "h4", "h5", "h6", "hr", "figure", "figcaption", "section"]);

DocxPacker.IMAGE_TYPE_TABLE = {
    "image/jpeg": {ext: "jpeg", contentType: "image/jpeg"},
    "image/png": {ext: "png", contentType: "image/png"},
    "image/gif": {ext: "gif", contentType: "image/gif"},
    "image/bmp": {ext: "bmp", contentType: "image/bmp"}
};

DocxPacker.PAGE_BREAK_PARAGRAPH_XML = "<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>";
DocxPacker.HORIZONTAL_RULE_PARAGRAPH_XML =
    "<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"auto\"/></w:pBdr></w:pPr></w:p>";

DocxPacker.PACKAGE_RELS_XML = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
    "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
    "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>" +
    "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>" +
    "<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties\" Target=\"docProps/app.xml\"/>" +
    "</Relationships>";

DocxPacker.APP_XML = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
    "<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\">" +
    "<Application>MassiveWebToDocx</Application></Properties>";

// Tell Word to prompt to update fields (the TOC) when the document is first opened.
DocxPacker.SETTINGS_XML = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
    "<w:settings xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">" +
    "<w:updateFields w:val=\"true\"/>" +
    "</w:settings>";

DocxPacker.STYLES_XML = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
    "<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">" +
    "<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\" w:cs=\"Calibri\"/>" +
    "<w:sz w:val=\"22\"/><w:szCs w:val=\"22\"/></w:rPr></w:rPrDefault></w:docDefaults>" +
    "<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\">" +
    "<w:name w:val=\"Normal\"/><w:qFormat/>" +
    "<w:pPr><w:spacing w:after=\"160\" w:line=\"276\" w:lineRule=\"auto\"/></w:pPr></w:style>" +
    DocxPacker.makeHeadingStyleXml(1, 32) +
    DocxPacker.makeHeadingStyleXml(2, 28) +
    DocxPacker.makeHeadingStyleXml(3, 26) +
    DocxPacker.makeHeadingStyleXml(4, 24) +
    DocxPacker.makeHeadingStyleXml(5, 22) +
    DocxPacker.makeHeadingStyleXml(6, 22) +
    "<w:style w:type=\"paragraph\" w:styleId=\"Title\">" +
    "<w:name w:val=\"Title\"/><w:qFormat/><w:pPr><w:jc w:val=\"center\"/><w:spacing w:after=\"480\"/></w:pPr>" +
    "<w:rPr><w:b/><w:sz w:val=\"56\"/><w:szCs w:val=\"56\"/></w:rPr></w:style>" +
    "<w:style w:type=\"paragraph\" w:styleId=\"Quote\">" +
    "<w:name w:val=\"Quote\"/><w:qFormat/><w:pPr><w:ind w:left=\"567\" w:right=\"567\"/></w:pPr>" +
    "<w:rPr><w:i/></w:rPr></w:style>" +
    "<w:style w:type=\"paragraph\" w:styleId=\"ListParagraph\">" +
    "<w:name w:val=\"List Paragraph\"/><w:qFormat/><w:pPr><w:ind w:left=\"284\"/></w:pPr></w:style>" +
    "<w:style w:type=\"character\" w:styleId=\"Hyperlink\">" +
    "<w:name w:val=\"Hyperlink\"/><w:rPr><w:color w:val=\"0563C1\"/><w:u w:val=\"single\"/></w:rPr></w:style>" +
    "</w:styles>";
