const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const imageType = (type: string) => ["image/png", "image/jpeg", "image/webp"].includes(type);
export function quoteTerminalPath(path: string): string {
  if (/[\x00-\x1f\x7f]/.test(path)) throw new Error("file path contains unsupported control characters");
  // Git Bash also accepts Windows drive paths with forward slashes.
  const normalized = /^[a-z]:\\/i.test(path) ? path.replace(/\\/g, "/") : path;
  return `'${normalized.replace(/'/g, `'"'"'`)}'`;
}

export function bindTerminalImages(host: HTMLElement, sink: {
  active: () => boolean;
  save: (data: number[]) => Promise<string>;
  paste: (text: string) => void;
  error: (message: string) => void;
}) {
  let disposed = false;
  let pending = false;
  const active = () => !disposed && sink.active();
  const dropPaths = (paths: string[]) => {
    if (!active()) return;
    try { if (paths.length) sink.paste(paths.map(quoteTerminalPath).join(" ") + " "); }
    catch (e) { sink.error(String(e)); }
  };
  const saveFiles = async (files: File[]) => {
    if (pending) { sink.error("An image is still being attached"); return; }
    pending = true;
    try {
      for (const file of files) {
        if (!imageType(file.type)) throw new Error("Paste a PNG, JPEG or WebP image");
        if (!file.size || file.size > MAX_IMAGE_BYTES) throw new Error("Images must be nonempty and at most 8 MiB");
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!active()) return;
        const path = await sink.save(Array.from(bytes));
        if (!active()) return;
        dropPaths([path]);
      }
    } catch (e) { if (!disposed) sink.error(String(e)); }
    finally { pending = false; }
  };
  const paste = (event: ClipboardEvent) => {
    if (!active()) return;
    const clipboard = event.clipboardData;
    const files = Array.from(clipboard?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) {
      for (const item of Array.from(clipboard?.items ?? [])) {
        if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (!files.length) return; // ordinary text remains xterm's responsibility
    event.preventDefault(); event.stopImmediatePropagation();
    void saveFiles(files);
  };
  const drop = (event: DragEvent) => {
    if (!active()) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void saveFiles(files);
  };
  const drag = (event: DragEvent) => { if (active() && event.dataTransfer?.types.includes("Files")) event.preventDefault(); };
  host.addEventListener("paste", paste, true);
  host.addEventListener("drop", drop, true);
  host.addEventListener("dragover", drag);
  return {
    dropPaths,
    dispose() {
      disposed = true;
      host.removeEventListener("paste", paste, true);
      host.removeEventListener("drop", drop, true);
      host.removeEventListener("dragover", drag);
    },
  };
}
