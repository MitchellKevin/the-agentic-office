// Project files drawer (the folder button in the top bar): reference files for the building on
// show. The robots in that building are told where these files are and read them when needed.
import { $, esc, relTime } from './util.js';

export function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export class FilesDrawer {
  /**
   * @param source    live or demo source (listFiles, uploadFile, removeFile)
   * @param getConfig () => state.config
   * @param toast     (html, opts) => void
   */
  constructor(source, { getConfig = () => ({}), toast = () => {} } = {}) {
    this.source = source;
    this.getConfig = getConfig;
    this.toast = toast;
    this.el = $('#filesDrawer');
    this.listEl = $('#fdList');
    this.key = null;
    this.files = [];
    this.dir = '';
    this.uploading = []; // { id, name, size }
    this.seq = 0;
    this.loadSeq = 0;

    $('#fdClose').addEventListener('click', () => this.toggle(false));
    const input = $('#fdInput');
    $('#fdAdd').addEventListener('click', () => input.click());
    input.addEventListener('change', () => { this.add([...input.files]); input.value = ''; });
    this.listEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-remove]');
      if (b) this.remove(b.dataset.remove);
    });

    // Drop files anywhere on the drawer.
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    this.el.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; this.el.classList.add('dragging'); });
    this.el.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    this.el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; this.el.classList.remove('dragging'); } });
    this.el.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      this.el.classList.remove('dragging');
      this.add([...e.dataTransfer.files]);
    });
  }

  get isOpen() { return !this.el.hidden; }

  /** The building on show changed (or was re-rendered). */
  set(projectKey, projectName) {
    $('#fdProject').textContent = projectName ? `· ${projectName}` : '';
    if (projectKey === this.key) return;
    this.key = projectKey;
    this.files = [];
    this.dir = '';
    this.uploading = [];
    this.render();
    this.load();
  }

  toggle(on = this.el.hidden) {
    this.el.hidden = !on;
    $('#filesBtn').setAttribute('aria-expanded', String(on));
    if (on) this.load();
  }

  async load() {
    if (!this.key || !this.source.listFiles) return;
    const key = this.key, seq = ++this.loadSeq;
    const r = await this.source.listFiles(key);
    if (seq !== this.loadSeq || key !== this.key) return; // the building changed meanwhile
    if (r.error) { this.files = []; this.dir = ''; }
    else { this.files = r.files || []; this.dir = r.dir || ''; }
    this.render();
  }

  async add(list) {
    if (!this.key || !list.length) return;
    const { maxFileBytes = 50 * 1024 * 1024 } = this.getConfig().files || {};
    const key = this.key;
    const replacing = list.filter((f) => this.files.some((x) => x.name === f.name)).map((f) => f.name);
    if (replacing.length && !confirm(`Replace ${replacing.length === 1 ? replacing[0] : `${replacing.length} files`} with the new version?`)) {
      list = list.filter((f) => !replacing.includes(f.name));
    }
    await Promise.all(list.map(async (file) => {
      if (!file.size) { this.toast(`${esc(file.name)} is empty, so it was skipped.`, { kind: 'bad' }); return; }
      if (file.size > maxFileBytes) { this.toast(`${esc(file.name)} is over ${Math.round(maxFileBytes / 1024 / 1024)} MB.`, { kind: 'bad' }); return; }
      const up = { id: ++this.seq, name: file.name, size: file.size };
      this.uploading.push(up);
      this.render();
      const r = await this.source.uploadFile(key, file);
      this.uploading = this.uploading.filter((u) => u !== up);
      if (key !== this.key) return;
      if (r.error) this.toast(`${esc(file.name)}: ${esc(r.error)}`, { kind: 'bad', ms: 6000 });
      else { this.files = r.files || this.files; this.dir = r.dir || this.dir; }
      this.render();
    }));
  }

  async remove(name) {
    if (!confirm(`Remove ${name} from the project files?\n\nThe robots can no longer read it. Copies elsewhere on your computer are not touched.`)) return;
    const key = this.key;
    const r = await this.source.removeFile(key, name);
    if (key !== this.key) return;
    if (r.error) { this.toast(esc(r.error), { kind: 'bad' }); this.load(); return; }
    this.files = r.files || this.files.filter((f) => f.name !== name);
    this.render();
  }

  render() {
    const badge = $('#filesBadge');
    badge.hidden = !this.files.length;
    badge.textContent = this.files.length;
    const now = Date.now();
    const rows = this.files.map((f) => `<li class="fd-item">
        <span class="fd-icon" aria-hidden="true">${icon(f.name)}</span>
        <span class="fd-name" title="${esc(f.name)}">${esc(f.name)}</span>
        <span class="fd-meta">${esc(fmtSize(f.size))}${f.mtime ? ` · ${esc(relTime(f.mtime, now))}` : ''}</span>
        <button type="button" class="icon-btn" data-remove="${esc(f.name)}" aria-label="Remove ${esc(f.name)}" title="Remove">✕</button>
      </li>`).join('')
      + this.uploading.map((u) => `<li class="fd-item uploading">
        <span class="fd-icon" aria-hidden="true">${icon(u.name)}</span>
        <span class="fd-name">${esc(u.name)}</span>
        <span class="fd-meta">${esc(fmtSize(u.size))} · uploading…</span>
      </li>`).join('');
    this.listEl.innerHTML = rows;
    $('#fdEmpty').hidden = !!rows;
    $('#fdDir').textContent = this.dir ? `Kept in ${this.dir}` : '';
  }
}

function icon(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic'].includes(ext)) return '🖼';
  if (ext === 'pdf') return '📕';
  if (['csv', 'xlsx', 'xls', 'tsv', 'json'].includes(ext)) return '📊';
  if (['zip', 'tar', 'gz'].includes(ext)) return '🗜';
  return '📄';
}
