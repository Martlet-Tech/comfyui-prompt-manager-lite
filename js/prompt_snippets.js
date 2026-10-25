/**
 * Prompt Snippets - a note-like node with a searchable snippet list.
 *
 * All snippet nodes share one library stored at
 * user/default/prompt_snippets.json (separate from the prompt-manager
 * library). Clicking a snippet copies it to the clipboard and sends it to
 * the node's "prompts" STRING output.
 */
import { app } from "../../scripts/app.js";

const SNIPPETS_PREFIX = "/prompt-snippets";

function forwardWheelToCanvas(element) {
    element.addEventListener("wheel", (e) => {
        const canvas = app.canvas?.canvas || document.querySelector("canvas.lgraphcanvas");
        if (canvas) {
            canvas.dispatchEvent(new WheelEvent("wheel", {
                bubbles: true, cancelable: true,
                clientX: e.clientX, clientY: e.clientY,
                deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ,
                deltaMode: e.deltaMode,
                ctrlKey: e.ctrlKey, shiftKey: e.shiftKey,
                altKey: e.altKey, metaKey: e.metaKey,
            }));
        }
    }, { passive: true, capture: true });
}

async function loadSnippets(node) {
    try {
        const r = await fetch(`${SNIPPETS_PREFIX}/get-snippets`);
        const data = await r.json();
        node.snippets = Array.isArray(data?.snippets) ? data.snippets : [];
    } catch (error) {
        console.error("[PromptSnippets] Error loading snippets:", error);
        node.snippets = [];
    }
}

async function persistSnippets(node) {
    try {
        const r = await fetch(`${SNIPPETS_PREFIX}/save-snippets`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ snippets: node.snippets }),
        });
        const data = await r.json();
        if (data.success && Array.isArray(data.snippets)) {
            node.snippets = data.snippets;
            return true;
        }
        return false;
    } catch (error) {
        console.error("[PromptSnippets] Error saving snippets:", error);
        return false;
    }
}

function copyText(text) {
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
    }
}

/** Build the node's single DOM widget: search + list + add row. */
function createSnippetsWidget(node) {
    const container = document.createElement("div");
    container.style.cssText = `
        display:flex; flex-direction:column; gap:6px;
        background:#171717; border-radius:6px; padding:7px;
        box-sizing:border-box; font-size:12px;
        height:100%; min-height:396px;
    `;
    container.addEventListener("contextmenu", (e) => e.preventDefault());
    forwardWheelToCanvas(container);

    // search
    const searchWrap = document.createElement("div");
    searchWrap.style.cssText = "position:relative;";
    const search = document.createElement("input");
    search.type = "text";
    search.placeholder = "搜索片段…";
    search.setAttribute("aria-label", "搜索片段");
    search.style.cssText = `
        width:100%; box-sizing:border-box; background:#0f0f0f;
        border:1px solid #333; border-radius:6px; color:#dcdcdc;
        padding:6px 8px 6px 26px; font-size:12px; outline:none;
    `;
    search.addEventListener("focus", () => { search.style.borderColor = "#3d5573"; });
    search.addEventListener("blur", () => { search.style.borderColor = "#333"; });
    const searchIcon = document.createElement("span");
    searchIcon.textContent = "⌕";
    searchIcon.style.cssText = `
        position:absolute; left:9px; top:6px; color:#6b6b6b;
        font-size:14px; pointer-events:none;
    `;
    searchWrap.appendChild(searchIcon);
    searchWrap.appendChild(search);

    // list
    const list = document.createElement("div");
    list.setAttribute("role", "list");
    list.setAttribute("aria-label", "片段列表");
    list.style.cssText = `
        display:flex; flex-direction:column; gap:5px;
        flex:1 1 0; min-height:60px; overflow-y:auto;
        scrollbar-width:thin; scrollbar-color:#333 transparent;
    `;

    // add row
    const addRow = document.createElement("div");
    addRow.style.cssText = "display:flex; gap:5px;";
    const newInput = document.createElement("input");
    newInput.type = "text";
    newInput.placeholder = "新片段内容，回车添加…";
    newInput.setAttribute("aria-label", "新片段内容");
    newInput.style.cssText = `
        flex:1; min-width:0; background:#0f0f0f; border:1px solid #333;
        border-radius:6px; color:#dcdcdc; padding:6px 8px; font-size:12px; outline:none;
    `;
    const newTag = document.createElement("input");
    newTag.type = "text";
    newTag.placeholder = "标签";
    newTag.setAttribute("aria-label", "新片段标签");
    newTag.style.cssText = `
        width:58px; background:#0f0f0f; border:1px solid #333;
        border-radius:6px; color:#dcdcdc; padding:6px 8px; font-size:12px; outline:none;
    `;
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.textContent = "＋";
    addBtn.setAttribute("aria-label", "添加片段");
    addBtn.style.cssText = `
        background:#2a3a4d; border:1px solid #3d5573; color:#a8c8ea;
        border-radius:6px; padding:6px 10px; font-size:12px; cursor:pointer;
    `;
    addRow.appendChild(newInput);
    addRow.appendChild(newTag);
    addRow.appendChild(addBtn);

    container.appendChild(searchWrap);
    container.appendChild(list);
    container.appendChild(addRow);

    // ---- behavior ----
    let toast = null;
    let toastTimer = null;
    function showToast(msg) {
        if (!toast) {
            toast = document.createElement("div");
            toast.setAttribute("role", "status");
            toast.setAttribute("aria-live", "polite");
            toast.style.cssText = `
                position:fixed; z-index:100000; padding:6px 12px;
                background:#1f2b1f; border:1px solid #3a5c3a; color:#9fd89f;
                border-radius:6px; font-size:12px; pointer-events:none;
                transition:opacity .2s;
            `;
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        const rect = container.getBoundingClientRect();
        toast.style.left = rect.left + "px";
        toast.style.top = (rect.bottom + 6) + "px";
        toast.style.opacity = "1";
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toast.style.opacity = "0"; }, 1400);
    }

    const outputWidget = node.widgets.find(w => w.name === "output_text");

    function setOutput(text, row) {
        if (outputWidget) outputWidget.value = text;
        node._selectedText = text;
        node.serialize_widgets = true;
        if (row) {
            for (const el of list.children) el.style.borderColor = "#2c2c2c";
            row.style.borderColor = "#3d5573";
        }
        app.graph?.setDirtyCanvas?.(true, true);
    }

    function render() {
        const q = (search.value || "").trim().toLowerCase();
        list.innerHTML = "";
        const data = (node.snippets || []).filter(s =>
            !q || (s.text || "").toLowerCase().includes(q) || (s.tag || "").toLowerCase().includes(q));

        if (data.length === 0) {
            const empty = document.createElement("div");
            empty.textContent = q ? "没有匹配的片段" : "还没有片段，在下方添加";
            empty.style.cssText = "text-align:center; color:#5a5a5a; padding:10px 0;";
            list.appendChild(empty);
            return;
        }

        data.forEach(s => {
            const row = document.createElement("div");
            row.setAttribute("role", "listitem");
            row.style.cssText = `
                display:flex; align-items:flex-start; gap:6px;
                background:#1f1f1f; border:1px solid #2c2c2c;
                border-radius:7px; padding:7px 8px; cursor:pointer;
            `;
            if (node._selectedText === s.text) row.style.borderColor = "#3d5573";

            const text = document.createElement("div");
            text.textContent = s.text;
            text.title = s.text;
            text.style.cssText = `
                flex:1; min-width:0; font-size:12.5px; line-height:1.45;
                word-break:break-word; color:#dcdcdc;
            `;

            const tag = document.createElement("span");
            tag.textContent = s.tag || "";
            tag.style.cssText = `
                flex-shrink:0; font-size:10.5px; color:#9db4c9;
                background:rgba(100,150,200,.14); border-radius:4px;
                padding:1px 6px; margin-top:1px; ${s.tag ? "" : "display:none;"}
            `;

            const actions = document.createElement("div");
            actions.style.cssText = "display:flex; gap:2px; flex-shrink:0;";
            const mkBtn = (label, title, fn) => {
                const b = document.createElement("button");
                b.type = "button";
                b.textContent = label;
                b.setAttribute("aria-label", title);
                b.title = title;
                b.style.cssText = `
                    background:transparent; border:none; color:#777;
                    padding:2px 4px; border-radius:4px; font-size:12px;
                    line-height:1; cursor:pointer;
                `;
                b.addEventListener("mouseenter", () => { b.style.color = "#fff"; b.style.background = "#2e2e2e"; });
                b.addEventListener("mouseleave", () => { b.style.color = "#777"; b.style.background = "transparent"; });
                b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
                return b;
            };

            actions.appendChild(mkBtn("⧉", "复制到剪贴板", () => {
                copyText(s.text);
                showToast("已复制");
            }));
            actions.appendChild(mkBtn("✎", "编辑", () => {
                const input = document.createElement("input");
                input.type = "text";
                input.value = s.text;
                input.setAttribute("aria-label", "编辑片段");
                input.style.cssText = `
                    width:100%; box-sizing:border-box; background:#0f0f0f;
                    border:1px solid #3d5573; border-radius:4px; color:#dcdcdc;
                    padding:3px 6px; font-size:12.5px; outline:none;
                `;
                text.replaceWith(input);
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
                const commit = () => {
                    const v = input.value.trim();
                    if (v && v !== s.text) {
                        s.text = v;
                        persistSnippets(node).then(ok => showToast(ok ? "已保存" : "保存失败"));
                    }
                    render();
                };
                input.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commit(); }
                    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); render(); }
                });
                input.addEventListener("blur", commit);
            }));
            actions.appendChild(mkBtn("🗑", "删除", () => {
                node.snippets = (node.snippets || []).filter(x => x.id !== s.id);
                persistSnippets(node).then(ok => showToast(ok ? "已删除" : "删除失败"));
                render();
            }));

            row.appendChild(text);
            row.appendChild(tag);
            row.appendChild(actions);

            // click text = use snippet: copy + send to output
            const useSnippet = () => {
                copyText(s.text);
                setOutput(s.text, row);
                showToast("已复制并输出到 prompts");
            };
            text.addEventListener("click", useSnippet);
            row.addEventListener("click", (e) => {
                if (e.target === text) useSnippet();
            });

            list.appendChild(row);
        });
    }

    function addSnippet() {
        const v = (newInput.value || "").trim();
        if (!v) return;
        node.snippets = node.snippets || [];
        node.snippets.unshift({
            id: "s" + Date.now(),
            text: v,
            tag: (newTag.value || "").trim(),
            created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        });
        newInput.value = "";
        newTag.value = "";
        persistSnippets(node).then(ok => showToast(ok ? "已添加" : "添加失败"));
        render();
    }

    addBtn.addEventListener("click", addSnippet);
    newInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); addSnippet(); }
        if (e.key === "Escape") newInput.blur();
    });
    newTag.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); addSnippet(); }
    });
    search.addEventListener("input", render);

    render();

    const widget = node.addDOMWidget("snippets", "div", container);
    widget.computeSize = function (width) {
        // Classic renderer: fixed-height fallback (search + capped list + add row)
        return [width, 402];
    };
    // Vue nodes mode: the row stays growable ('auto'), so enlarging the node
    // gives the extra space to the snippet list; the container fills the row
    // (height:100% + min-height) and the list flexes. Shrinking stops at the
    // 396px min-height, beyond which the list scrolls internally.

    widget._rerender = render;
    node.snippetsWidget = widget;
    return widget;
}

app.registerExtension({
    name: "PromptManagerLite.Snippets",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PromptSnippets") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;

            node.snippets = [];
            node._selectedText = "";
            this.setSize([360, 470]);

            // Hide the output_text widget everywhere (both renderers) but keep
            // serialization: options.hidden makes the render model suppress it.
            const outWidget = this.widgets.find(w => w.name === "output_text");
            if (outWidget) {
                outWidget.options = outWidget.options || {};
                outWidget.options.hidden = true;
                outWidget.computeSize = () => [0, -4];
            }

            createSnippetsWidget(node);

            loadSnippets(node).then(() => {
                node.snippetsWidget && node.snippetsWidget.element && renderSafe(node);
            });

            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const result = onConfigure?.apply(this, arguments);
            const node = this;
            if (!node.snippetsWidget) {
                createSnippetsWidget(node);
            }
            loadSnippets(node).then(() => renderSafe(node));
            return result;
        };

        function renderSafe(node) {
            // re-render through the widget's stored handler
            if (node.snippetsWidget?._rerender) node.snippetsWidget._rerender();
        }
    }
});

console.log("[PromptSnippets] Extension loaded");
