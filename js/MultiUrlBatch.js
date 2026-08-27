"use strict";

/**
 * MultiUrlBatch — cola de muchas novelas para procesar sin intervención manual.
 *
 * Pega varias URLs de inicio (una por novela, una por línea) y el botón
 * "Procesar toda la lista" hace, para cada una: "Load and Analyse", espera a
 * que aparezcan los capítulos, y arma el/los EPUB(s) (reusa AutoBatch cuando
 * la novela tiene más capítulos que "Auto lotes de").
 *
 * REQUISITOS antes de usar "Procesar toda la lista": los mismos que
 * AutoBatch: en "Advanced Options" activa "No popup on download" y
 * "Overwrite existing Epub" si vas a repetir pruebas.
 */
class MultiUrlBatch {
    static init() {
        let button = document.getElementById("multiUrlBatchButton");
        if (button) {
            button.onclick = MultiUrlBatch.run;
        }
    }

    static async run() {
        let button = document.getElementById("multiUrlBatchButton");
        let statusSpan = document.getElementById("multiUrlBatchStatus");
        let urlsInput = document.getElementById("multiUrlBatchInput");
        let urls = urlsInput.value
            .split("\n")
            .map(u => u.trim())
            .filter(u => u.length !== 0);

        if (urls.length === 0) {
            alert("Pega al menos una URL (una por línea).");
            return;
        }

        button.disabled = true;
        try {
            for (let i = 0; i < urls.length; i++) {
                let url = urls[i];
                MultiUrlBatch.setStatus(statusSpan, `Novela ${i + 1}/${urls.length}: cargando ${url} ...`);
                try {
                    await MultiUrlBatch.processOneNovel(url, i, urls.length, statusSpan);
                } catch (error) {
                    ErrorLog.log(error);
                    MultiUrlBatch.setStatus(statusSpan, `Novela ${i + 1}/${urls.length}: ERROR (${url}). Sigo con la siguiente...`);
                    await MultiUrlBatch.sleep(2000);
                }
            }
            MultiUrlBatch.setStatus(statusSpan, "Listo. Revisa tu carpeta de descargas.");
        } finally {
            button.disabled = false;
        }
    }

    static async processOneNovel(url, index, total, statusSpan) {
        main.resetUI();
        document.getElementById("startingUrlInput").value = url;
        await main.onLoadAndAnalyseButtonClick();

        if (main.getCurrentParser() == null) {
            throw new Error("No se encontró parser, o no cargaron capítulos, para " + url);
        }

        let rangeStart = document.getElementById("selectRangeStartChapter");
        let chapterCount = rangeStart.options.length;
        if (chapterCount === 0) {
            throw new Error("No se encontraron capítulos para " + url);
        }

        let batchSizeInput = document.getElementById("autoBatchSize");
        let batchSize = parseInt(batchSizeInput.value, 10) || 20;

        if (chapterCount > batchSize) {
            MultiUrlBatch.setStatus(statusSpan, `Novela ${index + 1}/${total}: ${chapterCount} capítulos, empacando en lotes de ${batchSize}...`);
            await AutoBatch.run();
        } else {
            MultiUrlBatch.setStatus(statusSpan, `Novela ${index + 1}/${total}: empacando ${chapterCount} capítulos...`);
            document.getElementById("packEpubButton").click();
            await AutoBatch.waitForPackToFinish();
            // pausa extra para que la descarga termine de escribirse antes de pasar a la siguiente novela
            await MultiUrlBatch.sleep(4000);
        }
    }

    static setStatus(statusSpan, text) {
        if (statusSpan) {
            statusSpan.textContent = text;
        }
    }

    static sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

document.addEventListener("DOMContentLoaded", MultiUrlBatch.init);
