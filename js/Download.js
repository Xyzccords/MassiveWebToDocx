"use strict";

class Download {
    constructor() {
    }

    static init() {
        Download.saveOn = util.isFirefox() ? Download.saveOnFirefox : Download.saveOnChrome;
        if (util.isFirefox()) {
            Download.saveOn = Download.saveOnFirefox;
            browser.downloads.onChanged.addListener(Download.onChanged);
        } else {
            Download.saveOn = Download.saveOnChrome;
            chrome.downloads.onChanged.addListener(Download.onChanged);
        }
    }

    static isFileNameIllegalOnWindows(fileName) {
        for (let c of Download.illegalWindowsFileNameChars) {
            if (fileName.includes(c)) {
                return true;
            }
        }
        if (fileName.trim() == "") {
            return true;
        }
        return false;
    }

    static CustomFilename() {
        let CustomFilename = document.getElementById("CustomFilenameInput").value;
        let ToReplace = {
            "%URL_hostname%": (new URL(document.getElementById("startingUrlInput").value))?.hostname,
            "%Title%": document.getElementById("titleInput").value,
            "%Author%": document.getElementById("authorInput").value,
            "%Language%": document.getElementById("languageInput").value,
            "%Chapters_Count%":  document.getElementById("spanChapterCount").innerHTML,
            "%Chapters_Downloaded%":  document.getElementById("fetchProgress").value-1,
            "%Filename%": document.getElementById("fileNameInput").value,
        };
        for (const [key, value] of Object.entries(ToReplace)) {
            CustomFilename = CustomFilename.replaceAll(key, value);
        }
        let addExtensionIfMissing = (main.getUserPreferences().outputFormat.value === "docx")
            ? DocxPacker.addExtensionIfMissing : EpubPacker.addExtensionIfMissing;
        if (Download.isFileNameIllegalOnWindows(CustomFilename)) {
            ErrorLog.showErrorMessage(UIText.Error.errorIllegalFileName(CustomFilename, Download.illegalWindowsFileNameChars));
            return Download.withNovelFolder(addExtensionIfMissing("IllegalFileName"));
        }
        return Download.withNovelFolder(addExtensionIfMissing(CustomFilename));
    }

    /**
     * When "organizeDownloadsInFolders" is on, prefix fileName with a
     * subfolder named after the novel (chrome.downloads / browser.downloads
     * create any subfolders in the path automatically, inside the browser's
     * configured downloads directory).
     */
    static withNovelFolder(fileName) {
        if (!main.getUserPreferences().organizeDownloadsInFolders.value) {
            return fileName;
        }
        let folder = Download.sanitizeFolderName(Download.currentNovelName());
        return util.isNullOrEmpty(folder) ? fileName : (folder + "/" + fileName);
    }

    // novelFolder is fixed once per novel when it's loaded; fileNameInput.value itself
    // gets mutated per-part by AutoBatch/MultiUrlBatch (e.g. "_lote01"), so don't use that.
    static currentNovelName() {
        let fileNameInput = document.getElementById("fileNameInput");
        return util.isNullOrEmpty(fileNameInput.dataset.novelFolder) ? fileNameInput.value : fileNameInput.dataset.novelFolder;
    }

    static sanitizeFolderName(name) {
        if (util.isNullOrEmpty(name)) {
            return "";
        }
        return name.replace(/[\\/:*?"<>|]/g, "_").trim();
    }

    /** Saves the novel's cover image on its own, as "Portada.<ext>", alongside the packed file */
    static saveCoverImage(coverImageInfo) {
        if ((coverImageInfo == null) || (coverImageInfo.arraybuffer == null)) {
            return Promise.resolve();
        }
        let userPreferences = main.getUserPreferences();
        if (!userPreferences.saveCoverImageSeparately.value) {
            return Promise.resolve();
        }
        let novelName = Download.currentNovelName();
        if (novelName === Download.lastCoverSavedForNovel) {
            return Promise.resolve(); // already saved for this novel (e.g. an earlier AutoBatch part)
        }
        Download.lastCoverSavedForNovel = novelName;
        let extension = Download.EXTENSION_BY_MEDIA_TYPE[coverImageInfo.mediaType] || "jpg";
        let fileName = Download.withNovelFolder("Portada." + extension);
        let blob = new Blob([coverImageInfo.arraybuffer], {type: coverImageInfo.mediaType});
        return Download.save(blob, fileName, userPreferences.overwriteExistingEpub.value, userPreferences.noDownloadPopup.value)
            .catch(err => ErrorLog.log(err));
    }

    /** write blob to "Downloads" directory */
    static save(blob, fileName, overwriteExisting, backgroundDownload) {
        let options = {
            url: URL.createObjectURL(blob),
            filename: fileName,
            saveAs: !backgroundDownload
        };
        if (overwriteExisting) {
            options.conflictAction = "overwrite";
        }
        let cleanup = () => { URL.revokeObjectURL(options.url); };
        return Download.saveOn(options, cleanup);
    }

    static saveOnChrome(options, cleanup) {
        // on Chrome call to download() will resolve when "Save As" dialog OPENS
        // so need to delay return until after file is actually saved
        // Otherwise, we get multiple Save As Dialogs open.
        return new Promise((resolve,reject) => {
            chrome.downloads.download(options, 
                downloadId => Download.downloadCallback(downloadId, cleanup, resolve, reject)
            );
        });
    }

    static downloadCallback(downloadId, cleanup, resolve, reject) {
        if (downloadId === undefined) {
            reject(new Error(chrome.runtime.lastError.message));
        } else {
            Download.onDownloadStarted(downloadId, 
                () => { 
                    const tenSeconds = 10 * 1000;
                    setTimeout(cleanup, tenSeconds);
                    resolve();
                }
            );
        }
    }

    static saveOnFirefox(options, cleanup) {
        return browser.runtime.getPlatformInfo().then(platformInfo => {
            if (Download.isAndroid(platformInfo)) {
                Download.saveOnFirefoxForAndroid(options, cleanup);
            } else {
                return browser.downloads.download(options).then(
                    // on Firefox, resolves when "Save As" dialog CLOSES, so no
                    // need to delay past this point.
                    downloadId => Download.onDownloadStarted(downloadId, cleanup)
                );
            }
        }).catch(cleanup);
    }

    static saveOnFirefoxForAndroid(options, cleanup) {
        options.saveAs = false;

        // `browser.downloads.download` isn't implemented in
        // "Firefox for Android" yet, so we starts downloads
        // the same way any normal web page would do it:
        const link = document.createElement("a");
        link.style.display = "hidden";

        link.href = options.url;
        link.download = options.filename;

        document.body.appendChild(link);
        try {
            link.click();
        } finally {
            document.body.removeChild(link);
        }
        cleanup();
    }

    static isAndroid(platformInfo) {
        return platformInfo.os.toLowerCase().includes("android");
    }

    static onChanged(delta) {
        if ((delta.state != null) && (delta.state.current === "complete")) {
            let action = Download.toCleanup.get(delta.id);
            if (action != null) {
                Download.toCleanup.delete(delta.id);
                action();
            }
        }
    }

    static onDownloadStarted(downloadId, action) {
        if (downloadId === undefined) {
            action();
        } else {
            Download.toCleanup.set(downloadId, action);
        }
    }
}

Download.toCleanup = new Map();
Download.illegalWindowsFileNameChars = "~/?<>\\:*|\"";
Download.EXTENSION_BY_MEDIA_TYPE = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg"
};
Download.lastCoverSavedForNovel = null;
Download.init();