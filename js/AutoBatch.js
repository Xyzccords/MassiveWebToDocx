"use strict";

/**
 * AutoBatch — modificación casera de WebToEpub.
 *
 * Agrega un botón "Procesar todo en lotes" que recorre automáticamente
 * todos los capítulos detectados, moviendo el rango "First/Last Chapter"
 * de N en N y disparando el mismo botón "Pack EPUB" que ya usas a mano.
 * No inventa ninguna forma nueva de bajar capítulos: solo automatiza
 * clics que tú harías de todos modos.
 *
 * REQUISITOS antes de usar "Procesar todo en lotes":
 *  - En "Advanced Options" activa "No popup on download" (para que no
 *    se trabe esperando que confirmes un diálogo de guardado en cada lote).
 *  - También activa "Overwrite existing Epub" si vas a repetir pruebas.
 */
class AutoBatch {
    static init() {
        let button = document.getElementById("autoBatchButton");
        if (button) {
            button.onclick = AutoBatch.run;
        }
    }

    static async run() {
        let button = document.getElementById("autoBatchButton");
        let statusSpan = document.getElementById("autoBatchStatus");
        let batchSizeInput = document.getElementById("autoBatchSize");
        let batchSize = parseInt(batchSizeInput.value, 10) || 20;

        let rangeStart = document.getElementById("selectRangeStartChapter");
        let rangeEnd = document.getElementById("selectRangeEndChapter");
        let total = rangeStart.options.length;

        if (total === 0) {
            alert("Primero carga la novela con 'Load and Analyse' (botón de arriba).");
            return;
        }

        let fileNameInput = document.getElementById("fileNameInput");
        let baseFileName = fileNameInput.value || "novela";

        button.disabled = true;

        try {
            for (let i = 0; i < total; i += batchSize) {
                let endIdx = Math.min(i + batchSize - 1, total - 1);
                let chapterRange = `${i + 1}-${endIdx + 1}`;

                rangeStart.selectedIndex = i;
                rangeEnd.selectedIndex = endIdx;
                ChapterUrlsUI.onRangeChanged();

                fileNameInput.value = chapterRange;

                if (statusSpan) {
                    statusSpan.textContent =
                        `Procesando capítulos ${chapterRange} de ${total}...`;
                }

                document.getElementById("packEpubButton").click();
                await AutoBatch.waitForPackToFinish();
                // pausa extra para que la descarga del lote termine de escribirse
                // antes de pasar al siguiente
                await AutoBatch.sleep(4000);
            }

            fileNameInput.value = baseFileName;
            if (statusSpan) {
                statusSpan.textContent = "Listo. Revisa tu carpeta de descargas.";
            }
        } finally {
            button.disabled = false;
        }
    }

    /** Espera a que el botón Pack EPUB se desactive (arrancó) y luego se reactive (terminó) */
    static waitForPackToFinish() {
        return new Promise((resolve) => {
            let started = false;
            let check = () => {
                let btn = document.getElementById("packEpubButton");
                if (!started) {
                    if (btn.disabled) {
                        started = true;
                    }
                    setTimeout(check, 200);
                    return;
                }
                if (!btn.disabled) {
                    resolve();
                } else {
                    setTimeout(check, 200);
                }
            };
            setTimeout(check, 200);
        });
    }

    static sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

document.addEventListener("DOMContentLoaded", AutoBatch.init);
