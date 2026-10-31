/*
   Real filesystem access for Chrome, via the File System Access API, as an alternative to
   chrome.downloads.download(). chrome.downloads only writes blind: it can't tell whether a file
   already exists on disk (only an approximate download *history*), and when it does collide it
   renames to "name (1).ext" instead of overwriting. Once the user grants access to a folder
   here, every check and write below reads/writes that folder directly, so "does this file exist"
   is a real answer and there's never a "(1)" duplicate.

   Not available in Firefox (no File System Access API) -- callers must fall back to
   chrome.downloads there, and anywhere isSupported() is false or no folder has been chosen yet.
*/
"use strict";

class FileSystemStorage {
    static isSupported() {
        return (typeof window !== "undefined") && (typeof window.showDirectoryPicker === "function");
    }

    static openDb() {
        return new Promise((resolve, reject) => {
            let request = indexedDB.open(FileSystemStorage.DB_NAME, 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore(FileSystemStorage.STORE_NAME);
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    static async storeHandle(handle) {
        let db = await FileSystemStorage.openDb();
        return new Promise((resolve, reject) => {
            let tx = db.transaction(FileSystemStorage.STORE_NAME, "readwrite");
            tx.objectStore(FileSystemStorage.STORE_NAME).put(handle, FileSystemStorage.HANDLE_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    static async loadStoredHandle() {
        let db = await FileSystemStorage.openDb();
        return new Promise((resolve, reject) => {
            let tx = db.transaction(FileSystemStorage.STORE_NAME, "readonly");
            let req = tx.objectStore(FileSystemStorage.STORE_NAME).get(FileSystemStorage.HANDLE_KEY);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => reject(req.error);
        });
    }

    /** Opens the native folder picker and remembers the chosen folder for next time. */
    static async chooseRootFolder() {
        let handle = await window.showDirectoryPicker({mode: "readwrite"});
        await FileSystemStorage.storeHandle(handle);
        FileSystemStorage.rootHandleCache = handle;
        return handle;
    }

    static async forgetRootFolder() {
        FileSystemStorage.rootHandleCache = null;
        let db = await FileSystemStorage.openDb();
        return new Promise((resolve, reject) => {
            let tx = db.transaction(FileSystemStorage.STORE_NAME, "readwrite");
            tx.objectStore(FileSystemStorage.STORE_NAME).delete(FileSystemStorage.HANDLE_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * Returns the stored folder handle, or null if none is configured or permission isn't
     * (re)granted. requestIfNeeded triggers the native permission re-prompt -- only pass true
     * from inside a flow that started with a real user click, or Chrome will silently refuse it.
     */
    static async getRootFolder(requestIfNeeded) {
        if (!FileSystemStorage.isSupported()) {
            return null;
        }
        let handle = FileSystemStorage.rootHandleCache ?? await FileSystemStorage.loadStoredHandle().catch(() => null);
        if (handle == null) {
            return null;
        }
        FileSystemStorage.rootHandleCache = handle;
        let opts = {mode: "readwrite"};
        if ((await handle.queryPermission(opts)) === "granted") {
            return handle;
        }
        if (requestIfNeeded && ((await handle.requestPermission(opts)) === "granted")) {
            return handle;
        }
        return null;
    }

    static async currentFolderName() {
        let handle = await FileSystemStorage.getRootFolder(false);
        return handle?.name ?? null;
    }

    /** Walks (and optionally creates) the subdirectories in a "a/b/c.ext" path, from rootHandle. */
    static async resolveFileHandle(rootHandle, path, create) {
        let parts = path.split("/").filter(p => p !== "");
        let dir = rootHandle;
        for (let i = 0; i < parts.length - 1; i++) {
            dir = await dir.getDirectoryHandle(parts[i], {create: create});
        }
        return await dir.getFileHandle(parts[parts.length - 1], {create: create});
    }

    static async resolveDirectoryHandle(rootHandle, dirPath, create) {
        let dir = rootHandle;
        for (let part of dirPath.split("/").filter(p => p !== "")) {
            dir = await dir.getDirectoryHandle(part, {create: create});
        }
        return dir;
    }

    /** True if "a/b/c.ext" exists under the configured root folder. */
    static async fileExists(path) {
        let root = await FileSystemStorage.getRootFolder(true);
        if (root == null) {
            return false;
        }
        try {
            await FileSystemStorage.resolveFileHandle(root, path, false);
            return true;
        } catch {
            return false;
        }
    }

    /** True if any file directly inside "a/b" starts with prefix (e.g. dir "Novela X", prefix "Portada."). */
    static async anyFileWithPrefix(dirPath, prefix) {
        let root = await FileSystemStorage.getRootFolder(true);
        if (root == null) {
            return false;
        }
        try {
            let dir = await FileSystemStorage.resolveDirectoryHandle(root, dirPath, false);
            for await (let name of dir.keys()) {
                if (name.startsWith(prefix)) {
                    return true;
                }
            }
            return false;
        } catch {
            return false;
        }
    }

    /**
     * Writes blob to "a/b/c.ext" under the configured root folder, creating subfolders as
     * needed. If overwrite is false and the file already exists, does nothing and returns
     * false -- there's no Chrome-style "(1)" fallback here, it's left exactly as it was.
     */
    static async writeFile(path, blob, overwrite) {
        let root = await FileSystemStorage.getRootFolder(true);
        if (root == null) {
            throw new Error("No root folder configured");
        }
        if (!overwrite && await FileSystemStorage.fileExists(path)) {
            return false;
        }
        let fileHandle = await FileSystemStorage.resolveFileHandle(root, path, true);
        let writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
    }

    static async readTextFile(path) {
        let root = await FileSystemStorage.getRootFolder(true);
        if (root == null) {
            return null;
        }
        try {
            let fileHandle = await FileSystemStorage.resolveFileHandle(root, path, false);
            let file = await fileHandle.getFile();
            return await file.text();
        } catch {
            return null;
        }
    }
}

FileSystemStorage.DB_NAME = "WebToDocxFileHandles";
FileSystemStorage.STORE_NAME = "handles";
FileSystemStorage.HANDLE_KEY = "rootFolder";
FileSystemStorage.rootHandleCache = null;
