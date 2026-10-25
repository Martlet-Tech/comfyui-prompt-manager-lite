/**
 * Prompt Manager Lite - minimal prompt library node for ComfyUI.
 *
 * UI: prompt selector (◀ category : name ▶) + multiline text editor +
 * Save Prompt / New Prompt / More button bar. Output: prompt STRING.
 *
 * The thumbnail browser (prompt_browser.js) is shared with the original
 * plugin; all library requests go to /prompt-manager-lite/*.
 */
import { app } from "../../scripts/app.js";
import { PM_UI_PALETTE as UI } from "./ui_palette.js";
import {
    configurePromptBrowserDeps,
    showThumbnailBrowser,
    openPromptBrowserForSave,
    getVisibleCategories,
    getPromptNamesForCategory,
} from "./prompt_browser.js";

const ENDPOINT_PREFIX = "/prompt-manager-lite";

const THEME = {
    panel: UI.panel || "hsl(216 11% 15%)",
    inputBorder: UI.inputBorder || "hsl(218 10% 41%)",
    sectionBorder: UI.sectionBorder || "hsl(216 20% 65% / 0.20)",
    textPrimary: UI.textPrimary || "hsl(0 0% 87%)",
    accentSoft: UI.accentSoft || "hsl(208 73% 57% / 0.16)",
};

const DEFAULT_THUMBNAIL = new URL("./placeholder.png", import.meta.url).href;

// ========================
// Small helpers
// ========================

/** Forward wheel events from node UI to the canvas so zoom keeps working. */
function forwardWheelToCanvas(element) {
    element.addEventListener("wheel", (e) => {
        const canvas = app.canvas?.canvas || document.querySelector("canvas.lgraphcanvas");
        if (canvas) {
            canvas.dispatchEvent(new WheelEvent("wheel", {
                bubbles: true,
                cancelable: true,
                clientX: e.clientX,
                clientY: e.clientY,
                deltaX: e.deltaX,
                deltaY: e.deltaY,
                deltaZ: e.deltaZ,
                deltaMode: e.deltaMode,
                ctrlKey: e.ctrlKey,
                shiftKey: e.shiftKey,
                altKey: e.altKey,
                metaKey: e.metaKey
            }));
        }
    }, { passive: true, capture: true });
}

function isHiddenCategoryEntryKey(key) {
    const normalized = String(key || "").toLowerCase();
    return normalized === "__meta__" || normalized === "_base_prompt_" || normalized === "_prompt_prefix_";
}

function warnUnsavedEnabled() {
    try {
        return app.ui.settings.getSettingValue("PromptManagerLite.WarnUnsavedChanges") !== false;
    } catch {
        return true;
    }
}

// ========================
// Data loading
// ========================

async function loadPrompts(node) {
    try {
        const response = await fetch(`${ENDPOINT_PREFIX}/get-prompts`);
        const data = await response.json();
        node.prompts = data;
        return data;
    } catch (error) {
        console.error("[PromptManagerLite] Error loading prompts:", error);
        node.prompts = {};
        return {};
    }
}

function filterPromptDropdown(node, options = {}) {
    const preserveDanglingSelection = options?.preserveDanglingSelection === true;
    const categoryWidget = node.widgets.find(w => w.name === "category");
    const promptWidget = node.widgets.find(w => w.name === "name");
    if (!categoryWidget || !promptWidget) return;

    const visibleCategories = getVisibleCategories(node, {});
    const currentCategoryValue = String(categoryWidget.value || "");
    let categoryOptions = visibleCategories.length > 0 ? [...visibleCategories] : ["Default"];
    if (preserveDanglingSelection && currentCategoryValue && !categoryOptions.includes(currentCategoryValue)) {
        categoryOptions = [currentCategoryValue, ...categoryOptions];
    }
    categoryWidget.options.values = categoryOptions;
    if (!categoryOptions.includes(categoryWidget.value)) {
        categoryWidget.value = visibleCategories[0] || "Default";
    }

    const currentCategory = categoryWidget.value;
    const promptNames = getPromptNamesForCategory(node, currentCategory, {});

    const currentPromptValue = String(promptWidget.value || "");
    const wantsEmptySelection = currentPromptValue === "";
    let promptOptions = promptNames.length > 0 ? [...promptNames] : [""];
    if (wantsEmptySelection && !promptOptions.includes("")) {
        promptOptions = ["", ...promptOptions];
    }
    if (preserveDanglingSelection && currentPromptValue && !promptOptions.includes(currentPromptValue)) {
        promptOptions = [currentPromptValue, ...promptOptions];
    }
    promptWidget.options.values = promptOptions;
    if (!promptOptions.includes(promptWidget.value)) {
        promptWidget.value = wantsEmptySelection ? "" : (promptOptions[0] || "");
    }
}

function updateDropdowns(node) {
    const categoryWidget = node.widgets.find(w => w.name === "category");
    const promptWidget = node.widgets.find(w => w.name === "name");
    const textWidget = node.widgets.find(w => w.name === "text");
    if (!categoryWidget || !promptWidget || !textWidget) return;

    const categories = Object.keys(node.prompts).sort((a, b) => a.localeCompare(b));
    categoryWidget.options.values = categories.length > 0 ? categories : ["Default"];

    if (!node.prompts[categoryWidget.value] && categories.length > 0) {
        categoryWidget.value = categories[0];
    }

    const currentCategory = categoryWidget.value;
    if (node.prompts[currentCategory]) {
        const promptNames = Object.keys(node.prompts[currentCategory])
            .filter(k => !isHiddenCategoryEntryKey(k))
            .sort((a, b) => a.localeCompare(b));
        const options = promptNames.length > 0 ? promptNames : [""];
        promptWidget.options.values = options;
        if (!node.prompts[currentCategory][promptWidget.value]) {
            promptWidget.value = promptNames.length > 0 ? promptNames[0] : "";
        }
        const promptData = node.prompts[currentCategory][promptWidget.value];
        textWidget.value = promptData?.prompt || "";
    } else {
        promptWidget.options.values = [""];
        promptWidget.value = "";
        textWidget.value = "";
    }
}

/** Load a prompt's text into the editor (lite only manages text). */
function loadPromptData(node, category, promptName) {
    const textWidget = node.widgets.find(w => w.name === "text");
    const promptData = node.prompts?.[category]?.[promptName];
    if (textWidget) {
        textWidget.value = promptData?.prompt || "";
    }
    updateLastSavedState(node);
}

// ========================
// Unsaved changes detection (text only)
// ========================

function getCurrentStateSnapshot(node) {
    const textWidget = node.widgets?.find(w => w.name === "text");
    return { text: textWidget?.value || "" };
}

function updateLastSavedState(node) {
    node.lastSavedState = getCurrentStateSnapshot(node);
}

function hasUnsavedChanges(node) {
    if (node.isNewUnsavedPrompt) return true;
    if (!node.lastSavedState) return false;
    return getCurrentStateSnapshot(node).text !== node.lastSavedState.text;
}

async function confirmDiscardUnsaved(node, actionLabel) {
    if (!hasUnsavedChanges(node) || !warnUnsavedEnabled()) {
        return true;
    }
    return await showConfirm(
        "Unsaved Changes",
        "You have unsaved changes to the current prompt. Do you want to discard them and " + actionLabel + "?",
        "Discard & " + actionLabel,
        "#f80"
    );
}

function clearNewPromptFlag(node) {
    node.isNewUnsavedPrompt = false;
    node.newPromptCategory = null;
    node.newPromptName = null;
}

// ========================
// API functions
// ========================

async function savePrompt(node, category, name, text) {
    try {
        const response = await fetch(`${ENDPOINT_PREFIX}/save-prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ category, name, text })
        });
        const data = await response.json();
        if (data.success) {
            node.prompts = data.prompts;
            return { success: true };
        }
        return { success: false, error: data.error || "Error saving prompt" };
    } catch (error) {
        console.error("[PromptManagerLite] Error saving prompt:", error);
        return { success: false, error: "Error saving prompt" };
    }
}

async function deletePrompt(node, category, name) {
    try {
        const response = await fetch(`${ENDPOINT_PREFIX}/delete-prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ category, name })
        });
        const data = await response.json();
        if (data.success) {
            node.prompts = data.prompts;
            updateDropdowns(node);

            const categoryWidget = node.widgets.find(w => w.name === "category");
            const promptWidget = node.widgets.find(w => w.name === "name");
            const currentCategory = categoryWidget?.value;
            const newPrompt = promptWidget?.value || "";

            if (currentCategory && newPrompt && node.prompts[currentCategory]?.[newPrompt]) {
                loadPromptData(node, currentCategory, newPrompt);
            } else {
                const textWidget = node.widgets.find(w => w.name === "text");
                if (textWidget) textWidget.value = "";
            }

            node._previousCategory = currentCategory;
            node._previousPrompt = newPrompt;
            if (node.updatePromptSelectorDisplay) node.updatePromptSelectorDisplay();
            updateLastSavedState(node);
            node.serialize_widgets = true;
            app.graph.setDirtyCanvas(true, true);
        } else {
            await showInfo("Error", data.error);
        }
    } catch (error) {
        console.error("[PromptManagerLite] Error deleting prompt:", error);
        await showInfo("Error", "Error deleting prompt");
    }
}

async function exportPromptsJSON() {
    try {
        const response = await fetch(`${ENDPOINT_PREFIX}/get-prompts`);
        const data = await response.json();
        const jsonStr = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonStr], { type: "application/json" });

        if (window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: "prompt_manager_data.json",
                    types: [{ description: "JSON Files", accept: { "application/json": [".json"] } }]
                });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                await showInfo("Export Complete", "Prompts exported successfully!");
                return;
            } catch (err) {
                if (err.name === "AbortError") return;
            }
        }

        const filename = await showTextPrompt("Export Prompts", "Enter filename for export:", "prompt_manager_data.json");
        if (!filename) return;
        const finalFilename = filename.endsWith(".json") ? filename : filename + ".json";

        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = finalFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        await showInfo("Export Complete", "Prompts exported successfully!");
    } catch (error) {
        console.error("[PromptManagerLite] Error exporting prompts:", error);
        await showInfo("Error", "Failed to export prompts");
    }
}

async function importPromptsJSON(node) {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";

        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) {
                resolve(false);
                return;
            }
            try {
                const text = await file.text();
                const importedData = JSON.parse(text);
                if (typeof importedData !== "object" || Array.isArray(importedData)) {
                    await showInfo("Error", "Invalid JSON structure. Expected an object with categories.");
                    resolve(false);
                    return;
                }

                const importMode = await showImportOptions();
                if (importMode === null) {
                    resolve(false);
                    return;
                }

                const response = await fetch(`${ENDPOINT_PREFIX}/import-prompts`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ data: importedData, mode: importMode })
                });
                const result = await response.json();

                if (result.success) {
                    node.prompts = result.prompts;
                    updateDropdowns(node);
                    const categoryWidget = node.widgets.find(w => w.name === "category");
                    const promptWidget = node.widgets.find(w => w.name === "name");
                    if (categoryWidget && promptWidget && promptWidget.value) {
                        loadPromptData(node, categoryWidget.value, promptWidget.value);
                    }
                    if (node.updatePromptSelectorDisplay) node.updatePromptSelectorDisplay();
                    node.serialize_widgets = true;
                    app.graph.setDirtyCanvas(true, true);
                    await showInfo("Import Complete", "Successfully imported prompts!");
                    resolve(true);
                } else {
                    await showInfo("Error", result.error || "Failed to import prompts");
                    resolve(false);
                }
            } catch (error) {
                console.error("[PromptManagerLite] Error importing prompts:", error);
                await showInfo("Error", "Failed to parse JSON file");
                resolve(false);
            }
        };

        input.click();
    });
}

// ========================
// Dialogs
// ========================

function showConfirm(title, message, confirmText = "Delete", confirmColor = "#c44") {
    return new Promise((resolve) => {
        const dialog = document.createElement("div");
        dialog.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: ${THEME.panel}; border: 1px solid ${THEME.sectionBorder};
            border-radius: 8px; padding: 20px; z-index: 10000; min-width: 300px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5); color: ${THEME.textPrimary};
        `;
        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.7); z-index: 9999;
        `;
        dialog.innerHTML = `
            <div style="margin-bottom: 15px; font-size: 16px; font-weight: bold;">${title}</div>
            <div style="margin-bottom: 20px; line-height: 1.4; opacity: 0.75;">${message}</div>
            <div style="display: flex; gap: 10px; justify-content: flex-end;">
                <button class="cancel-btn" style="padding: 8px 16px; background: hsl(219 16% 18%); color: ${THEME.textPrimary}; border: 1px solid ${THEME.inputBorder}; border-radius: 4px; cursor: pointer;">Cancel</button>
                <button class="ok-btn" style="padding: 8px 16px; background: ${confirmColor}; color: #fff; border: 1px solid transparent; border-radius: 4px; cursor: pointer;">${confirmText}</button>
            </div>
        `;
        const okBtn = dialog.querySelector(".ok-btn");
        const cancelBtn = dialog.querySelector(".cancel-btn");
        const cleanup = () => {
            if (overlay.parentNode) document.body.removeChild(overlay);
            document.body.removeChild(dialog);
        };
        okBtn.onclick = () => { resolve(true); cleanup(); };
        cancelBtn.onclick = () => { resolve(false); cleanup(); };
        overlay.onclick = () => { resolve(false); cleanup(); };
        document.body.appendChild(overlay);
        document.body.appendChild(dialog);
        okBtn.focus();
    });
}

function showInfo(title, message) {
    return new Promise((resolve) => {
        const dialog = document.createElement("div");
        dialog.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: ${THEME.panel}; border: 1px solid ${THEME.sectionBorder};
            border-radius: 8px; padding: 20px; z-index: 10000; min-width: 300px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5); color: ${THEME.textPrimary};
        `;
        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.7); z-index: 9999;
        `;
        dialog.innerHTML = `
            <div style="margin-bottom: 15px; font-size: 16px; font-weight: bold;">${title}</div>
            <div style="margin-bottom: 20px; line-height: 1.4; opacity: 0.75;">${message}</div>
            <div style="display: flex; gap: 10px; justify-content: flex-end;">
                <button class="ok-btn" style="padding: 8px 16px; background: #2b6d3a; color: #fff; border: 1px solid #4a9158; border-radius: 4px; cursor: pointer;">OK</button>
            </div>
        `;
        const okBtn = dialog.querySelector(".ok-btn");
        const cleanup = () => {
            if (overlay.parentNode) document.body.removeChild(overlay);
            document.body.removeChild(dialog);
        };
        okBtn.onclick = () => { resolve(true); cleanup(); };
        overlay.onclick = () => { resolve(true); cleanup(); };
        document.body.appendChild(overlay);
        document.body.appendChild(dialog);
        okBtn.focus();
    });
}

function showNewCategoryDialog() {
    return new Promise((resolve) => {
        const dialog = document.createElement("div");
        dialog.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: #222; border: 2px solid #444; border-radius: 8px; padding: 20px;
            z-index: 10000; min-width: 300px; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        `;
        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.7); z-index: 9999;
        `;
        dialog.innerHTML = `
            <div style="margin-bottom: 15px; font-size: 16px; font-weight: bold; color: #fff;">New Category</div>
            <div style="margin-bottom: 10px; color: #ccc;">Enter new category name:</div>
            <input type="text" value="" style="width: 100%; padding: 8px; margin-bottom: 12px; background: #333; border: 1px solid #555; color: #fff; border-radius: 4px; font-size: 14px; box-sizing: border-box;" />
            <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 15px; color: #aaa; font-size: 13px; cursor: pointer; user-select: none;">
                <input type="checkbox" class="nsfw-cb" style="cursor: pointer; accent-color: #c44;" />
                Mark as NSFW
            </label>
            <div style="display: flex; gap: 10px; justify-content: flex-end;">
                <button class="cancel-btn" style="padding: 8px 16px; background: #555; color: #fff; border: none; border-radius: 4px; cursor: pointer;">Cancel</button>
                <button class="ok-btn" style="padding: 8px 16px; background: #0a0; color: #fff; border: none; border-radius: 4px; cursor: pointer;">OK</button>
            </div>
        `;
        const input = dialog.querySelector("input[type='text']");
        const nsfwCb = dialog.querySelector(".nsfw-cb");
        const cleanup = () => {
            document.body.removeChild(overlay);
            document.body.removeChild(dialog);
        };
        const handleOk = () => { resolve({ name: input.value, nsfw: nsfwCb.checked }); cleanup(); };
        const handleCancel = () => { resolve(null); cleanup(); };
        dialog.querySelector(".ok-btn").onclick = handleOk;
        dialog.querySelector(".cancel-btn").onclick = handleCancel;
        overlay.onclick = handleCancel;
        input.onkeydown = (e) => {
            if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); handleOk(); }
            else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); handleCancel(); }
        };
        document.body.appendChild(overlay);
        document.body.appendChild(dialog);
        input.focus();
    });
}

function showRenameCategoryDialog(title, message, categories, defaultCategory) {
    return new Promise((resolve) => {
        const dialog = document.createElement("div");
        dialog.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: #222; border: 2px solid #444; border-radius: 8px; padding: 20px;
            z-index: 10000; min-width: 320px; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        `;
        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.7); z-index: 9999;
        `;
        const normalizedCategories = Array.isArray(categories) ? categories : [];
        const showCategorySelect = normalizedCategories.length > 1;
        const selectHtml = showCategorySelect ? `
            <div style="margin-bottom: 6px; color: #aaa; font-size: 12px;">Category to rename:</div>
            <select class="category-select" style="width: 100%; padding: 8px; margin-bottom: 12px; background: #333; border: 1px solid #555; color: #fff; border-radius: 4px; font-size: 14px;">
                ${normalizedCategories.map((c) => `<option value="${c}"${c === defaultCategory ? " selected" : ""}>${c}</option>`).join("")}
            </select>
        ` : "";
        dialog.innerHTML = `
            <div style="margin-bottom: 15px; font-size: 16px; font-weight: bold; color: #fff;">${title}</div>
            ${selectHtml}
            <div style="margin-bottom: 6px; color: #aaa; font-size: 12px;">${message}</div>
            <input type="text" value="${String(defaultCategory || "")}" style="width: 100%; padding: 8px; margin-bottom: 12px; background: #333; border: 1px solid #555; color: #fff; border-radius: 4px; font-size: 14px; box-sizing: border-box;" />
            <div style="display: flex; gap: 10px; justify-content: flex-end;">
                <button class="cancel-btn" style="padding: 8px 16px; background: #555; color: #fff; border: none; border-radius: 4px; cursor: pointer;">Cancel</button>
                <button class="ok-btn" style="padding: 8px 16px; background: #0a0; color: #fff; border: none; border-radius: 4px; cursor: pointer;">OK</button>
            </div>
        `;
        const selectEl = dialog.querySelector(".category-select");
        const input = dialog.querySelector("input");
        const cleanup = () => {
            document.body.removeChild(overlay);
            document.body.removeChild(dialog);
        };
        if (selectEl) {
            selectEl.onchange = () => { input.value = selectEl.value; input.select(); };
        }
        const handleOk = () => {
            resolve({ oldCategory: String(selectEl?.value || defaultCategory || ""), newCategory: String(input?.value || "") });
            cleanup();
        };
        const handleCancel = () => { resolve(null); cleanup(); };
        dialog.querySelector(".ok-btn").onclick = handleOk;
        dialog.querySelector(".cancel-btn").onclick = handleCancel;
        overlay.onclick = handleCancel;
        input.onkeydown = (e) => {
            if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); handleOk(); }
            else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); handleCancel(); }
        };
        document.body.appendChild(overlay);
        document.body.appendChild(dialog);
        input.focus();
        input.select();
    });
}

function showTextPrompt(title, message, defaultValue = "") {
    return new Promise((resolve) => {
        const dialog = document.createElement("div");
        dialog.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: #222; border: 2px solid #444; border-radius: 8px; padding: 20px;
            z-index: 10000; min-width: 300px; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        `;
        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.7); z-index: 9999;
        `;
        dialog.innerHTML = `
            <div style="margin-bottom: 15px; font-size: 16px; font-weight: bold; color: #fff;">${title}</div>
            <div style="margin-bottom: 10px; color: #ccc;">${message}</div>
            <input type="text" value="${String(defaultValue || "")}" style="width: 100%; padding: 8px; margin-bottom: 15px; background: #333; border: 1px solid #555; color: #fff; border-radius: 4px; font-size: 14px; box-sizing: border-box;" />
            <div style="display: flex; gap: 10px; justify-content: flex-end;">
                <button class="cancel-btn" style="padding: 8px 16px; background: #555; color: #fff; border: none; border-radius: 4px; cursor: pointer;">Cancel</button>
                <button class="ok-btn" style="padding: 8px 16px; background: #0a0; color: #fff; border: none; border-radius: 4px; cursor: pointer;">OK</button>
            </div>
        `;
        const input = dialog.querySelector("input");
        const cleanup = () => {
            document.body.removeChild(overlay);
            document.body.removeChild(dialog);
        };
        const handleOk = () => { resolve(input.value); cleanup(); };
        const handleCancel = () => { resolve(null); cleanup(); };
        dialog.querySelector(".ok-btn").onclick = handleOk;
        dialog.querySelector(".cancel-btn").onclick = handleCancel;
        overlay.onclick = handleCancel;
        input.onkeydown = (e) => {
            if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); handleOk(); }
            else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); handleCancel(); }
        };
        document.body.appendChild(overlay);
        document.body.appendChild(dialog);
        input.focus();
        input.select();
    });
}

function showImportOptions() {
    return new Promise((resolve) => {
        const dialog = document.createElement("div");
        dialog.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: #222; border: 2px solid #444; border-radius: 8px; padding: 20px;
            z-index: 10000; min-width: 320px; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        `;
        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.7); z-index: 9999;
        `;
        dialog.innerHTML = `
            <div style="margin-bottom: 15px; font-size: 16px; font-weight: bold; color: #fff;">Import Prompts</div>
            <div style="margin-bottom: 20px; color: #ccc;">How do you want to import?<br><br>
                <strong>Merge:</strong> Keep existing prompts, add/update from import<br>
                <strong>Replace:</strong> Delete all existing, use import only
            </div>
            <div style="display: flex; gap: 10px; justify-content: flex-end;">
                <button class="cancel-btn" style="padding: 8px 16px; background: #555; color: #fff; border: none; border-radius: 4px; cursor: pointer;">Cancel</button>
                <button class="replace-btn" style="padding: 8px 16px; background: #c00; color: #fff; border: none; border-radius: 4px; cursor: pointer;">Replace</button>
                <button class="merge-btn" style="padding: 8px 16px; background: #0a0; color: #fff; border: none; border-radius: 4px; cursor: pointer;">Merge</button>
            </div>
        `;
        const cleanup = () => {
            document.body.removeChild(overlay);
            document.body.removeChild(dialog);
        };
        dialog.querySelector(".merge-btn").onclick = () => { resolve("merge"); cleanup(); };
        dialog.querySelector(".replace-btn").onclick = () => { resolve("replace"); cleanup(); };
        dialog.querySelector(".cancel-btn").onclick = () => { resolve(null); cleanup(); };
        overlay.onclick = () => { resolve(null); cleanup(); };
        document.body.appendChild(overlay);
        document.body.appendChild(dialog);
        dialog.querySelector(".merge-btn").focus();
    });
}

// ========================
// UI widgets
// ========================

function createButton(text, callback) {
    const button = document.createElement("button");
    button.textContent = text;
    button.style.flex = "1";
    button.style.minWidth = "80px";
    button.style.padding = "6px 8px";
    button.style.cursor = "pointer";
    button.style.backgroundColor = "#222";
    button.style.color = "#fff";
    button.style.border = "1px solid #444";
    button.style.borderRadius = "6px";
    button.style.fontSize = "11px";
    button.style.whiteSpace = "nowrap";
    button.style.overflow = "hidden";
    button.style.textOverflow = "ellipsis";
    button.style.lineHeight = "normal";
    button.style.height = "28px";
    button.style.display = "flex";
    button.style.alignItems = "center";
    button.style.justifyContent = "center";
    button.onclick = callback;
    return button;
}

function createDropdownButton(text, items, ownerNode) {
    const container = document.createElement("div");
    container.style.position = "relative";
    container.style.flex = "1";
    container.style.minWidth = "80px";

    const button = document.createElement("button");
    button.textContent = text;
    button.style.width = "100%";
    button.style.padding = "6px 8px";
    button.style.cursor = "pointer";
    button.style.backgroundColor = "#222";
    button.style.color = "#fff";
    button.style.border = "1px solid #444";
    button.style.borderRadius = "6px";
    button.style.fontSize = "11px";
    button.style.whiteSpace = "nowrap";
    button.style.height = "28px";
    button.style.display = "flex";
    button.style.alignItems = "center";
    button.style.justifyContent = "center";

    // Dropdown is appended to document.body to escape the canvas stacking context
    const dropdown = document.createElement("div");
    dropdown.style.cssText = `
        position: fixed;
        background: ${THEME.panel};
        border: 1px solid ${THEME.inputBorder};
        border-radius: 6px;
        z-index: 999999;
        display: none;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        min-width: 140px;
    `;
    document.body.appendChild(dropdown);
    // Tag with the owning node so its onRemoved can clean up the detached menu
    if (ownerNode) {
        if (!ownerNode._liteUiUid) ownerNode._liteUiUid = "lite-" + Math.random().toString(36).slice(2);
        dropdown.dataset.liteOwner = ownerNode._liteUiUid;
    }

    items.forEach(item => {
        if (item.divider) {
            const divider = document.createElement("div");
            divider.style.cssText = `height: 1px; background: ${THEME.sectionBorder}; margin: 4px 0;`;
            dropdown.appendChild(divider);
        } else {
            const menuItem = document.createElement("div");
            menuItem.textContent = item.label;
            menuItem.style.cssText = `
                padding: 8px 12px;
                cursor: pointer;
                font-size: 11px;
                color: ${THEME.textPrimary};
                white-space: nowrap;
            `;
            menuItem.addEventListener("mouseenter", () => {
                menuItem.style.backgroundColor = THEME.accentSoft;
            });
            menuItem.addEventListener("mouseleave", () => {
                menuItem.style.backgroundColor = "transparent";
            });
            menuItem.addEventListener("click", (e) => {
                e.stopPropagation();
                dropdown.style.display = "none";
                item.action();
            });
            dropdown.appendChild(menuItem);
        }
    });

    button.addEventListener("click", (e) => {
        e.stopPropagation();
        const isVisible = dropdown.style.display === "block";
        if (isVisible) {
            dropdown.style.display = "none";
        } else {
            const rect = button.getBoundingClientRect();
            dropdown.style.left = rect.left + "px";
            dropdown.style.top = (rect.bottom + 2) + "px";
            dropdown.style.display = "block";
        }
    });

    document.addEventListener("click", (e) => {
        if (!dropdown.contains(e.target) && e.target !== button) {
            dropdown.style.display = "none";
        }
    });

    container.appendChild(button);
    return container;
}

/**
 * Custom prompt selector widget: ◀ category : name ▶ with thumbnail hover
 * preview; clicking the middle opens the thumbnail browser in select mode.
 */
function createPromptSelectorWidget(node) {
    const categoryWidget = node.widgets.find(w => w.name === "category");
    const promptWidget = node.widgets.find(w => w.name === "name");
    if (!categoryWidget || !promptWidget) return;

    // Hide the original widgets visually but keep them functional
    categoryWidget.type = "converted-widget";
    categoryWidget.computeSize = () => [0, -4];
    promptWidget.type = "converted-widget";
    promptWidget.computeSize = () => [0, -4];

    for (let i = node.inputs.length - 1; i >= 0; i--) {
        const inp = node.inputs[i];
        if (inp.name === "category" || inp.name === "name") {
            node.removeInput(i);
        }
    }

    const container = document.createElement("div");
    container.style.cssText = `
        display: flex; align-items: center; gap: 0;
        background: #1a1a1a; border-radius: 4px; overflow: visible;
        height: 26px; margin: 0; position: relative;
    `;
    container.addEventListener("contextmenu", (e) => e.preventDefault());
    forwardWheelToCanvas(container);

    const leftArrow = document.createElement("button");
    leftArrow.textContent = "◀";
    leftArrow.style.cssText = `
        background: #2a2a2a; border: none; color: #888; padding: 0 10px;
        height: 100%; cursor: pointer; font-size: 10px; transition: all 0.15s ease;
    `;
    leftArrow.onmouseover = () => { leftArrow.style.background = "#3a3a3a"; leftArrow.style.color = "#fff"; };
    leftArrow.onmouseout = () => { leftArrow.style.background = "#2a2a2a"; leftArrow.style.color = "#888"; };

    const nameDisplay = document.createElement("div");
    nameDisplay.style.cssText = `
        flex: 1; text-align: center; color: #dbeafe; font-size: 13px; padding: 0 10px;
        cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        background: rgba(56, 130, 246, 0.22); border: 1px solid rgba(56, 130, 246, 0.85);
        border-radius: 4px; height: 100%; display: flex; align-items: center;
        justify-content: center; transition: background 0.15s ease; box-sizing: border-box;
    `;
    nameDisplay.onmouseover = () => nameDisplay.style.background = "rgba(56, 130, 246, 0.32)";
    nameDisplay.onmouseout = () => nameDisplay.style.background = "rgba(56, 130, 246, 0.22)";

    const rightArrow = document.createElement("button");
    rightArrow.textContent = "▶";
    rightArrow.style.cssText = leftArrow.style.cssText;
    rightArrow.onmouseover = () => { rightArrow.style.background = "#3a3a3a"; rightArrow.style.color = "#fff"; };
    rightArrow.onmouseout = () => { rightArrow.style.background = "#2a2a2a"; rightArrow.style.color = "#888"; };

    container.appendChild(leftArrow);
    container.appendChild(nameDisplay);
    container.appendChild(rightArrow);

    // Thumbnail preview tooltip (screen-fixed)
    const thumbnailPreview = document.createElement("div");
    thumbnailPreview.style.cssText = `
        position: fixed; display: none; z-index: 10001; pointer-events: none;
    `;
    const thumbnailImg = document.createElement("img");
    thumbnailImg.style.cssText = `
        max-width: 300px; max-height: 300px; object-fit: contain; border-radius: 8px;
        display: block; box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    `;
    thumbnailPreview.appendChild(thumbnailImg);
    document.body.appendChild(thumbnailPreview);

    let hoverTimeout = null;
    nameDisplay.addEventListener("mouseenter", () => {
        hoverTimeout = setTimeout(() => {
            const category = categoryWidget.value;
            const prompt = promptWidget.value;
            const thumbnail = node.prompts?.[category]?.[prompt]?.thumbnail || DEFAULT_THUMBNAIL;
            if (thumbnail === DEFAULT_THUMBNAIL) return;

            const tempImg = new Image();
            tempImg.onload = function () {
                const imgWidth = this.naturalWidth;
                const imgHeight = this.naturalHeight;
                thumbnailImg.style.width = imgWidth + "px";
                thumbnailImg.style.height = imgHeight + "px";
                thumbnailImg.src = thumbnail;

                const rect = nameDisplay.getBoundingClientRect();
                const margin = 8;
                const previewWidth = Math.min(imgWidth, 300);
                const previewHeight = Math.min(imgHeight, 300);
                let left = rect.left + (rect.width / 2) - (previewWidth / 2);
                let top = rect.top - previewHeight - margin;
                left = Math.max(5, Math.min(left, window.innerWidth - previewWidth - 5));
                top = Math.max(5, Math.min(top, window.innerHeight - previewHeight - 5));
                thumbnailPreview.style.left = left + "px";
                thumbnailPreview.style.top = top + "px";
                thumbnailPreview.style.display = "block";
            };
            tempImg.src = thumbnail;
        }, 300);
    });
    nameDisplay.addEventListener("mouseleave", () => {
        if (hoverTimeout) clearTimeout(hoverTimeout);
        thumbnailPreview.style.display = "none";
    });

    node.onRemoved = function () {
        if (thumbnailPreview && thumbnailPreview.parentNode) {
            thumbnailPreview.parentNode.removeChild(thumbnailPreview);
        }
        // Remove the detached More dropdown (it lives on document.body)
        const uid = node._liteUiUid;
        if (uid) {
            for (const el of [...document.body.children]) {
                if (el.dataset?.liteOwner === uid) el.remove();
            }
        }
    };

    const updateDisplay = () => {
        const category = categoryWidget.value || "";
        const prompt = promptWidget.value || "new prompt";
        nameDisplay.textContent = `${category} : ${prompt}`;
        nameDisplay.title = `${category} : ${prompt}`;

        const existingNsfwLabel = nameDisplay.querySelector(".nsfw-selector-label");
        if (existingNsfwLabel) existingNsfwLabel.remove();

        const promptData = node.prompts?.[category]?.[prompt] || null;
        const catIsNSFW = node.prompts?.[category]?.["__meta__"]?.nsfw === true;
        if ((catIsNSFW || promptData?.nsfw === true) && prompt) {
            const label = document.createElement("span");
            label.className = "nsfw-selector-label";
            label.textContent = "NSFW";
            label.style.cssText = `
                background: rgba(204, 50, 50, 0.85); color: #fff; font-size: 8px;
                font-weight: bold; padding: 0px 4px; border-radius: 2px; margin-left: 6px;
                flex-shrink: 0; line-height: 12px;
            `;
            nameDisplay.appendChild(label);
        }
    };

    // Flattened prompt list across all categories for arrow navigation
    const getAllPromptsFlat = () => {
        const allPrompts = [];
        if (!node.prompts) return allPrompts;
        const categories = getVisibleCategories(node, {});
        for (const cat of categories) {
            const prompts = getPromptNamesForCategory(node, cat, {});
            for (const prompt of prompts) {
                allPrompts.push({ category: cat, prompt: prompt });
            }
        }
        return allPrompts;
    };

    const navigateTo = async (item, skipUnsavedCheck = false) => {
        if (!skipUnsavedCheck) {
            const confirmed = await confirmDiscardUnsaved(node, "switch");
            if (!confirmed) return false;
            clearNewPromptFlag(node);
        }

        node._skipUnsavedCheck = true;
        try {
            if (item.category !== categoryWidget.value) {
                categoryWidget.value = item.category;
                if (categoryWidget.callback) {
                    await categoryWidget.callback(item.category);
                }
            }
            if (promptWidget.callback) {
                await promptWidget.callback(item.prompt);
            }
            promptWidget.value = item.prompt;
            updateDisplay();
            app.graph.setDirtyCanvas(true, true);
        } finally {
            node._skipUnsavedCheck = false;
        }
        return true;
    };

    leftArrow.onclick = async (e) => {
        e.stopPropagation();
        const allPrompts = getAllPromptsFlat();
        if (allPrompts.length === 0) return;
        const currentIndex = allPrompts.findIndex(p =>
            p.category === categoryWidget.value && p.prompt === promptWidget.value);
        const newIndex = currentIndex <= 0 ? allPrompts.length - 1 : currentIndex - 1;
        await navigateTo(allPrompts[newIndex]);
    };

    rightArrow.onclick = async (e) => {
        e.stopPropagation();
        const allPrompts = getAllPromptsFlat();
        if (allPrompts.length === 0) return;
        const currentIndex = allPrompts.findIndex(p =>
            p.category === categoryWidget.value && p.prompt === promptWidget.value);
        const newIndex = currentIndex >= allPrompts.length - 1 ? 0 : currentIndex + 1;
        await navigateTo(allPrompts[newIndex]);
    };

    nameDisplay.onclick = async (e) => {
        e.stopPropagation();
        try {
            const confirmed = await confirmDiscardUnsaved(node, "browse");
            if (!confirmed) return;

            const selection = await showThumbnailBrowser(
                node, categoryWidget.value, promptWidget.value, { allowMultiSelect: false });
            if (selection) {
                await navigateTo(selection, true);
                clearNewPromptFlag(node);
            }
        } catch (err) {
            console.error("[PromptManagerLite] Error opening prompt browser:", err);
        }
    };

    updateDisplay();

    const widget = node.addDOMWidget("prompt_selector", "div", container);
    widget.computeSize = function (width) {
        return [width, 28];
    };
    // Vue node mode sizes each widget row by content ('min-content') unless the
    // widget reports a layout size. DOMWidgetImpl carries a prototype
    // computeLayoutSize (min 50, unbounded) which would make this row growable
    // and stretch the selector whenever the node is enlarged. Shadow it so the
    // row stays content-sized and only the text area absorbs extra height.
    widget.computeLayoutSize = undefined;

    node.promptSelectorWidget = widget;
    node._promptSelectorContainer = container;
    node.updatePromptSelectorDisplay = updateDisplay;
    return widget;
}

/** Save Prompt / New Prompt / More button bar. */
function addButtonBar(node) {
    if (node.buttonBarAttached) return;

    const textWidget = node.widgets.find(w => w.name === "text");
    const categoryWidget = node.widgets.find(w => w.name === "category");
    const promptWidget = node.widgets.find(w => w.name === "name");

    const buttonContainer = document.createElement("div");
    buttonContainer.style.display = "flex";
    buttonContainer.style.gap = "2px";
    buttonContainer.style.padding = "4px 4px 8px 4px";
    buttonContainer.style.flexWrap = "wrap";
    buttonContainer.style.marginTop = "0";
    buttonContainer.addEventListener("contextmenu", (e) => e.preventDefault());
    forwardWheelToCanvas(buttonContainer);

    const savePromptBtn = createButton("Save Prompt", async () => {
        await openPromptBrowserForSave({
            node,
            currentCategory: categoryWidget.value,
            currentPrompt: promptWidget.value || "",
            title: "Save Prompt",
            saveButtonText: "Save",
            namePlaceholder: "Prompt name",
            initialName: (promptWidget.value || "").trim() || "New Prompt",
            onSave: async ({ category, name }) => {
                const promptName = String(name || "").trim();
                const targetCategory = String(category || "").trim();
                const promptText = textWidget.value;
                if (!promptName || !targetCategory) {
                    return { success: false, error: "Category and prompt name are required." };
                }

                try {
                    const result = await savePrompt(node, targetCategory, promptName, promptText);
                    if (!result.success) {
                        return result;
                    }

                    node._skipCallbackReload = true;
                    categoryWidget.value = targetCategory;
                    filterPromptDropdown(node);
                    promptWidget.value = promptName;
                    textWidget.value = promptText;
                    node._skipCallbackReload = false;

                    node._previousCategory = targetCategory;
                    node._previousPrompt = promptName;

                    if (node.updatePromptSelectorDisplay) node.updatePromptSelectorDisplay();
                    updateLastSavedState(node);

                    return { success: true, category: targetCategory, name: promptName, overwritten: true };
                } catch (err) {
                    console.error("[PromptManagerLite] Error during save:", err);
                    return { success: false, error: err?.message || "Error during save" };
                } finally {
                    clearNewPromptFlag(node);
                }
            },
        });
    });

    const newPromptBtn = createButton("New Prompt", async () => {
        const confirmed = await confirmDiscardUnsaved(node, "start fresh");
        if (!confirmed) return;

        const currentCategory = categoryWidget.value;
        promptWidget.value = "";
        textWidget.value = "";
        node._previousCategory = currentCategory;
        node._previousPrompt = "";

        if (node.updatePromptSelectorDisplay) node.updatePromptSelectorDisplay();

        node.isNewUnsavedPrompt = true;
        node.newPromptCategory = currentCategory;
        node.newPromptName = null;
        node.lastSavedState = null;

        node.serialize_widgets = true;
        app.graph.setDirtyCanvas(true, true);
    });

    const moreBtn = createDropdownButton("More ▼", [
        {
            label: "Delete Prompt",
            action: async () => {
                const currentCategory = categoryWidget.value;
                const currentPrompt = promptWidget.value;
                if (!currentPrompt) {
                    await showInfo("Error", "No prompt selected to delete.");
                    return;
                }
                const confirmed = await showConfirm(
                    "Delete Prompt",
                    `Are you sure you want to delete "${currentPrompt}" from category "${currentCategory}"? This cannot be undone.`,
                    "Delete",
                    "#c00"
                );
                if (confirmed) {
                    await deletePrompt(node, currentCategory, currentPrompt);
                }
            }
        },
        { divider: true },
        { label: "Export JSON", action: async () => { await exportPromptsJSON(); } },
        { label: "Import JSON", action: async () => { await importPromptsJSON(node); } }
    ], node);

    buttonContainer.appendChild(savePromptBtn);
    buttonContainer.appendChild(newPromptBtn);
    buttonContainer.appendChild(moreBtn);

    const htmlWidget = node.addDOMWidget("buttons", "div", buttonContainer);
    htmlWidget.computeSize = function (width) {
        return [width, 40];
    };
    // Keep the button row content-sized in Vue node mode (see prompt_selector).
    htmlWidget.computeLayoutSize = undefined;

    node.buttonBarAttached = true;
}

/**
 * Route category/name widget callbacks through reload + unsaved-changes checks.
 */
function setupCategoryChangeHandler(node) {
    const categoryWidget = node.widgets.find(w => w.name === "category");
    const promptWidget = node.widgets.find(w => w.name === "name");
    const textWidget = node.widgets.find(w => w.name === "text");
    if (!categoryWidget || !promptWidget || !textWidget) return;

    node._previousCategory = categoryWidget.value;
    node._previousPrompt = promptWidget.value;

    const originalCallback = categoryWidget.callback;
    categoryWidget.callback = async function (value) {
        if (node._restoringFromWorkflow || node._skipCallbackReload) {
            if (originalCallback) originalCallback.apply(this, arguments);
            return;
        }

        if (!node._skipUnsavedCheck) {
            const confirmed = await confirmDiscardUnsaved(node, "switch");
            if (!confirmed) {
                categoryWidget.value = node._previousCategory;
                if (node._previousPrompt && !promptWidget.options.values.includes(node._previousPrompt)) {
                    promptWidget.options.values = [...promptWidget.options.values, node._previousPrompt]
                        .sort((a, b) => a.localeCompare(b));
                }
                promptWidget.value = node._previousPrompt;
                app.graph.setDirtyCanvas(true, true);
                return;
            }
            clearNewPromptFlag(node);
        }

        if (originalCallback) originalCallback.apply(this, arguments);

        await loadPrompts(node);

        const category = value;
        if (node.prompts && node.prompts[category]) {
            const promptNames = Object.keys(node.prompts[category])
                .filter(k => !isHiddenCategoryEntryKey(k));
            promptWidget.options.values = promptNames;

            if (promptNames.length > 0) {
                promptWidget.value = promptNames[0];
                loadPromptData(node, category, promptNames[0]);
            } else {
                promptWidget.value = "";
                textWidget.value = "";
                updateLastSavedState(node);
            }

            node._previousCategory = category;
            node._previousPrompt = promptWidget.value;
            if (node.updatePromptSelectorDisplay) node.updatePromptSelectorDisplay();

            node.serialize_widgets = true;
            app.graph.setDirtyCanvas(true, true);
        }
    };

    const originalPromptCallback = promptWidget.callback;
    promptWidget.callback = async function (value) {
        if (node._restoringFromWorkflow || node._skipCallbackReload) {
            if (originalPromptCallback) originalPromptCallback.apply(this, arguments);
            return;
        }

        if (!node._skipUnsavedCheck) {
            const confirmed = await confirmDiscardUnsaved(node, "switch");
            if (!confirmed) {
                if (node._previousPrompt && !promptWidget.options.values.includes(node._previousPrompt)) {
                    promptWidget.options.values = [...promptWidget.options.values, node._previousPrompt]
                        .sort((a, b) => a.localeCompare(b));
                }
                promptWidget.value = node._previousPrompt;
                app.graph.setDirtyCanvas(true, true);
                return;
            }
            clearNewPromptFlag(node);
        }

        if (originalPromptCallback) originalPromptCallback.apply(this, arguments);

        await loadPrompts(node);

        const category = categoryWidget.value;
        if (node.prompts && node.prompts[category]) {
            const promptNames = Object.keys(node.prompts[category])
                .filter(k => !isHiddenCategoryEntryKey(k))
                .sort((a, b) => a.localeCompare(b));
            promptWidget.options.values = promptNames.length > 0 ? promptNames : [""];

            if (!promptNames.includes(value)) {
                value = promptNames.length > 0 ? promptNames[0] : "";
                promptWidget.value = value;
            }
        }

        loadPromptData(node, category, value);

        node._previousCategory = category;
        node._previousPrompt = value;
        if (node.updatePromptSelectorDisplay) node.updatePromptSelectorDisplay();

        node.serialize_widgets = true;
        app.graph.setDirtyCanvas(true, true);
    };

    // When ComfyUI assigns cross-category values to the name dropdown,
    // re-filter to the current category's prompts.
    Object.defineProperty(promptWidget.options, "values", {
        get: function () { return this._values; },
        set: function (newValues) {
            this._values = newValues;
            if (node.prompts && categoryWidget && newValues && newValues.length > 0) {
                const currentCategory = categoryWidget.value;
                if (node.prompts[currentCategory]) {
                    const categoryPrompts = Object.keys(node.prompts[currentCategory])
                        .filter(k => !isHiddenCategoryEntryKey(k));
                    const hasOtherCategoryPrompts = newValues.some(
                        val => val !== "" && !categoryPrompts.includes(val));
                    if (hasOtherCategoryPrompts) {
                        setTimeout(() => {
                            filterPromptDropdown(node, {
                                preserveDanglingSelection: node._restoringFromWorkflow === true,
                            });
                        }, 50);
                    }
                }
            }
        },
        enumerable: true,
        configurable: true
    });
    promptWidget.options._values = promptWidget.options.values || [];
}

// ========================
// Extension registration
// ========================

app.registerExtension({
    name: "PromptManagerLite",

    settings: [
        {
            id: "PromptManagerLite.WarnUnsavedChanges",
            category: ["Prompt Manager Lite", "Warn Unsaved Changes"],
            name: "Warn about unsaved prompt changes",
            tooltip: "Show a warning when switching prompts if there are unsaved changes to the current prompt text.",
            type: "boolean",
            defaultValue: true
        },
    ],

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PromptManagerLite") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;

            node.prompts = {};
            node.lastSavedState = { text: "" };
            node.isNewUnsavedPrompt = false;

            this.setSize([440, 420]);

            const textWidget = this.widgets.find(w => w.name === "text");
            if (textWidget) {
                textWidget.label = "prompt";
                if (textWidget.inputEl) {
                    textWidget.inputEl.style.pointerEvents = "auto";
                }
            }

            // Add DOM widgets synchronously during node creation
            createPromptSelectorWidget(node);
            addButtonBar(node);
            setupCategoryChangeHandler(node);

            loadPrompts(node).then(() => {
                filterPromptDropdown(node, { preserveDanglingSelection: true });
                if (node.updatePromptSelectorDisplay) node.updatePromptSelectorDisplay();
                if (!node._configuredFromWorkflow) {
                    const categoryWidget = node.widgets.find(w => w.name === "category");
                    const promptWidget = node.widgets.find(w => w.name === "name");
                    if (categoryWidget && promptWidget && promptWidget.value) {
                        loadPromptData(node, categoryWidget.value, promptWidget.value);
                    }
                }
            });

            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const result = onConfigure?.apply(this, arguments);
            const node = this;

            node._configuredFromWorkflow = true;

            if (!node.promptSelectorWidget) {
                createPromptSelectorWidget(node);
            }
            for (let i = node.inputs.length - 1; i >= 0; i--) {
                const inp = node.inputs[i];
                if (inp.name === "category" || inp.name === "name") {
                    node.removeInput(i);
                }
            }
            if (!node.buttonBarAttached) {
                addButtonBar(node);
                setupCategoryChangeHandler(node);
            }

            node._restoringFromWorkflow = true;
            loadPrompts(node).then(() => {
                try {
                    filterPromptDropdown(node, { preserveDanglingSelection: true });
                    updateLastSavedState(node);
                    if (node.updatePromptSelectorDisplay) node.updatePromptSelectorDisplay();
                    app.graph.setDirtyCanvas(true, true);
                } finally {
                    node._restoringFromWorkflow = false;
                }
            });

            return result;
        };

        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            size[0] = Math.max(440, size[0]);
            size[1] = Math.max(300, size[1]);
            if (onResize) onResize.apply(this, arguments);
            return size;
        };
    }
});

configurePromptBrowserDeps({
    app,
    UI,
    DEFAULT_THUMBNAIL,
    loadPrompts,
    showInfo,
    showConfirm: (title, message, confirmText, confirmColor) => showConfirm(title, message, confirmText, confirmColor),
    showRenameCategoryDialog,
    showNewCategoryDialog,
});

console.log("[PromptManagerLite] Extension loaded");
