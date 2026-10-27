
const $ = id => document.getElementById(id);
const KEY = "amophor_data_v1";
const W = 5000;
const H = 3500;
const CELL = 40;

const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) +
      Math.random().toString(36).slice(2);

let data;
try {
  data = JSON.parse(localStorage.getItem(KEY));
} catch {
  data = null;
}
if (!data || !Array.isArray(data.projects)) {
  data = { projects: [] };
}

let projectId = null;
let currentId = null;
let tool = "select";
let selected = null;
let selectedIds = new Set();
let connectFrom = null;
let zoom = .75;
let panX = 0;
let panY = 0;
let gesture = null;
let stroke = null;
let painting = false;
let lastPaintPoint = null;
let history = [];
let modalAction = null;
let saveTimer = null;
let clipboard = null;
let pasteOffset = 0;

const viewport = $("viewport");
const board = $("board");
const canvas = $("drawingCanvas");
const ctx = canvas.getContext("2d");
const layer = $("objectLayer");
const lines = $("connectionLayer");
const marqueeBox = $("marqueeBox");
const selectionBox = $("selectionBox");
const groupResizeHandle = $("groupResizeHandle");

// SALVAMENTO

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (error) {
      console.error(error);
      alert("Armazenamento cheio. Exporte um backup.");
    }
  }, 300);
}

function saveNow() {
  clearTimeout(saveTimer);
  localStorage.setItem(KEY, JSON.stringify(data));
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

function validColor(color, fallback = "#805b91") {
  return /^#[0-9a-f]{6}$/i.test(color || "")
    ? color : fallback;
}

function isDarkColor(hex) {
  const rgb = validColor(hex).slice(1)
    .match(/../g)
    .map(v => parseInt(v, 16));

  return (
    rgb[0] * .299 +
    rgb[1] * .587 +
    rgb[2] * .114
  ) < 155;
}

// TRANSFERÊNCIA DE PROJETOS E CONTEÚDO

let transferAction = "export";

function updateTransferDialog() {
  const kind = $("transferKind").value;
  const descriptions = {
    backup: "Exporta ou mescla todos os projetos do arquivo.",
    project: "Transfere o projeto que está aberto no momento.",
    folder: "Transfere a pasta atualmente aberta.",
    workspace: "Transfere o workspace atualmente aberto."
  };

  $("transferTitle").textContent =
    transferAction === "export" ? "Exportar conteúdo" : "Importar conteúdo";
  $("runTransfer").textContent =
    transferAction === "export" ? "Exportar" : "Escolher arquivo";
  $("transferDescription").textContent = descriptions[kind];

  [...$("transferKind").options].forEach(option => {
    option.disabled = false;
    if (transferAction !== "export") return;
    if (option.value === "project") option.disabled = !project();
    if (option.value === "folder") {
      option.disabled = currentNode()?.type !== "folder";
    }
    if (option.value === "workspace") {
      option.disabled = currentNode()?.type !== "workspace";
    }
  });
}

function openTransferDialog(action) {
  transferAction = action;
  const kind = workspace() ? "workspace" :
    currentNode()?.type === "folder" ? "folder" :
    project() ? "project" : "backup";
  $("transferKind").value = action === "export" ? kind : "backup";
  updateTransferDialog();
  $("transferDialog").showModal();
}

function downloadJson(value, filename) {
  const blob = new Blob(
    [JSON.stringify(value, null, 2)],
    { type: "application/json" }
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportTransfer() {
  const kind = $("transferKind").value;
  let item;

  if (kind === "backup") {
    downloadJson(data, "amophor-backup.json");
    return;
  }

  if (kind === "project") item = project();
  if (kind === "folder" || kind === "workspace") {
    item = currentNode();
  }

  if (!item || (kind !== "project" && item.type !== kind)) {
    alert("Abra o conteúdo que deseja exportar primeiro.");
    return;
  }

  downloadJson(
    { format: "amophor-item-v1", kind, item },
    `amophor-${kind}-${item.name.replace(/[^a-z0-9_-]+/gi, "-")}.json`
  );
}

$("exportBtn").onclick = () => openTransferDialog("export");
$("importBtn").onclick = () => openTransferDialog("import");
$("transferKind").onchange = updateTransferDialog;
$("cancelTransfer").onclick = () => $("transferDialog").close();

$("runTransfer").onclick = () => {
  if (transferAction === "export") {
    exportTransfer();
    $("transferDialog").close();
  } else {
    $("transferDialog").close();
    $("backupInput").click();
  }
};

$("backupInput").onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const imported = JSON.parse(await file.text());
    const additions = [];
    let targetNode = null;
    let importedNode = null;

    if (imported.format === "amophor-item-v1") {
      const { kind, item } = imported;
      const isProject = kind === "project" && item?.children;
      const validNode = ["folder", "workspace"].includes(kind) &&
        item?.type === kind;
      if (!isProject && !validNode) throw new Error("Arquivo inválido");

      const copy = cloneNodeWithFreshIds(item);
      if (kind === "project") {
        additions.push(copy);
      } else {
        targetNode = currentNode()?.type === "folder"
          ? currentNode()
          : project();
        if (!targetNode) throw new Error("Abra um projeto antes de importar");
        importedNode = copy;
      }
    } else if (Array.isArray(imported.projects)) {
      imported.projects.forEach(p => additions.push(cloneNodeWithFreshIds(p)));
    } else {
      throw new Error("Arquivo inválido");
    }

    const oldProjects = data.projects;
    const oldChildren = targetNode?.children;
    if (targetNode) {
      targetNode.children = [...targetNode.children, importedNode];
    }
    data.projects = [...oldProjects, ...additions];
    try {
      migrateData();
      saveNow();
    } catch (error) {
      data.projects = oldProjects;
      if (targetNode) targetNode.children = oldChildren;
      throw error;
    }

    if (workspace()) openWorkspace(false);
    else if (project()) openFolderView();
    else home();
  } catch (error) {
    console.error(error);
    alert("Não foi possível importar este arquivo.");
  } finally {
    e.target.value = "";
  }
};

// PROJETOS, PASTAS E WORKSPACES

function makeFolder(name) {
  return {
    id: uid(), type: "folder",
    name, cover: null, children: []
  };
}

function makeWorkspace(name) {
  return {
    id: uid(), type: "workspace",
    name, cover: null,
    objects: [], strokes: [],
    connections: [], cells: []
  };
}

function project() {
  return data.projects.find(p => p.id === projectId);
}

function findNode(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    if (n.type === "folder") {
      const result = findNode(n.children, id);
      if (result) return result;
    }
  }
  return null;
}

function currentNode() {
  return currentId
    ? findNode(project()?.children, currentId)
    : null;
}

function workspace() {
  const n = currentNode();
  return n?.type === "workspace" ? n : null;
}

function container() {
  const n = currentNode();
  return n?.type === "folder" ? n : project();
}

function removeNode(nodes, id) {
  const i = nodes.findIndex(n => n.id === id);
  if (i >= 0) {
    nodes.splice(i, 1);
    return true;
  }
  for (const n of nodes) {
    if (n.type === "folder" &&
        removeNode(n.children, id)) return true;
  }
  return false;
}

function cloneNodeWithFreshIds(source) {
  const copy = JSON.parse(JSON.stringify(source));

  function visit(node) {
    node.id = uid();

    if (node.type === "workspace") {
      const objectIds = new Map();
      (node.objects || []).forEach(o => {
        const oldId = o.id;
        o.id = uid();
        objectIds.set(oldId, o.id);
      });
      (node.connections || []).forEach(c => {
        c.id = uid();
        c.from = objectIds.get(c.from) || c.from;
        c.to = objectIds.get(c.to) || c.to;
      });
      (node.strokes || []).forEach(s => { s.id = uid(); });
      (node.cells || []).forEach(c => { c.id = uid(); });
    } else if (node.type === "folder") {
      (node.children || []).forEach(visit);
    } else if (Array.isArray(node.children)) {
      node.children.forEach(visit);
    }
  }

  visit(copy);
  return copy;
}

// COMPATIBILIDADE COM BACKUPS ANTIGOS

function migrateBlocks(old, target) {
  (old.blocks || []).forEach((b, i) => {
    if (["text", "mixed"].includes(b.type)) {
      target.objects.push({
        id: uid(),
        type: "text",
        title: b.title || "Anotação",
        text: b.text || "",
        minimized: !!b.minimized,
        x: 200 + i % 4 * 350,
        y: 180 + Math.floor(i / 4) * 300,
        w: 320,
        h: b.minimized ? 100 : 260,
        color: "#302a36",
        fontSize: 17,
        transparent: false
      });
    }

    const images = b.drawing?.images ||
      (b.image ? [{ src: b.image }] : []);

    images.forEach((im, j) => {
      if (!im.src) return;
      target.objects.push({
        id: uid(), type: "image",
        src: im.src,
        x: 250 + j * 70,
        y: 500 + i * 120,
        w: im.width || 400,
        h: im.height || 250
      });
    });

    (b.drawing?.actions || []).forEach(a => {
      target.strokes.push({
        id: uid(),
        color: a.color || "#805b91",
        size: a.size || 4,
        points: a.points || []
      });
    });
  });
}

function migrateFolder(old) {
  const f = makeFolder(old.name || "Pasta");
  f.id = old.id || uid();
  f.cover = old.cover || null;
  f.children = (old.children || old.folders || [])
    .map(migrateFolder);

  if (
    old.objects?.length ||
    old.strokes?.length ||
    old.blocks?.length
  ) {
    const w = makeWorkspace("Painel original");
    w.objects = old.objects || [];
    w.strokes = old.strokes || [];
    migrateBlocks(old, w);
    f.children.unshift(w);
  }
  return f;
}

function migrateData() {
  data.projects.forEach(p => {
    if (!Array.isArray(p.children)) {
      p.children = (p.folders || []).map(migrateFolder);

      if (
        p.objects?.length ||
        p.strokes?.length ||
        p.blocks?.length
      ) {
        const w = makeWorkspace("Painel principal");
        w.objects = p.objects || [];
        w.strokes = p.strokes || [];
        migrateBlocks(p, w);
        p.children.unshift(w);
      }

      delete p.folders;
      delete p.objects;
      delete p.strokes;
      delete p.blocks;
    }

    function visit(nodes) {
      nodes.forEach(n => {
        if (n.type === "workspace") {
          n.objects ||= [];
          n.strokes ||= [];
          n.connections ||= [];
          n.cells ||= [];
          n.strokes.forEach(s => { s.id ||= uid(); });
          n.cells.forEach(c => { c.id ||= uid(); });

          n.objects.forEach(o => {
            if (o.type === "text") {
              o.fontSize ??= 17;
              o.transparent ??= false;
              o.color ||= "#302a36";
            }
          });
        } else if (n.type === "folder") {
          n.children ||= [];
          visit(n.children);
        }
      });
    }

    visit(p.children);
  });
}

migrateData();

// JANELA DE NOMES

function openDialog(title, value, callback) {
  $("dialogTitle").textContent = title;
  $("nameInput").value = value || "";
  modalAction = callback;
  $("nameDialog").showModal();
  $("nameInput").focus();
}

$("nameForm").onsubmit = e => {
  e.preventDefault();
  const name = $("nameInput").value.trim();
  if (!name) return;
  $("nameDialog").close();
  modalAction?.(name);
};

$("cancelDialog").onclick = () =>
  $("nameDialog").close();

// NAVEGAÇÃO

function showView(id) {
  [
    "projectsView", "folderView",
    "workspaceView", "aboutView"
  ].forEach(v => {
    $(v).classList.toggle("hidden", v !== id);
  });
}

function updateHeader() {
  const p = project();
  const n = currentNode();

  $("breadcrumbs").textContent = p
    ? "Meus projetos / " + p.name +
      (n ? " / " + n.name : "")
    : "Meus projetos";

  $("renameBtn").classList.toggle("hidden", !p);
  $("deleteBtn").classList.toggle("hidden", !p);
}

function makeCard(item, type, onOpen) {
  const el = document.createElement("div");
  el.className = "item-card " + type + "-card";

  const cover = document.createElement("div");
  cover.className = "item-cover";

  if (item.cover) {
    const img = document.createElement("img");
    img.src = item.cover;
    img.alt = item.name;
    cover.append(img);
  } else {
    cover.textContent =
      type === "folder" ? "📁" :
      type === "workspace" ? "▧" : "✿";
  }

  const info = document.createElement("div");
  info.className = "item-info";
  info.innerHTML = `
    <h3>${esc(item.name)}</h3>
    <p>${
      type === "folder" ? "Pasta" :
      type === "workspace" ? "Workspace visual" :
      "Projeto"
    }</p>
  `;

  cover.onclick = info.onclick = onOpen;

  const actions = document.createElement("div");
  actions.className = "item-actions";

  const button = document.createElement("button");
  button.className = "secondary";
  button.textContent = "Alterar miniatura";

  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.hidden = true;

  button.onclick = () => input.click();

  input.onchange = async () => {
    if (!input.files[0]) return;
    try {
      item.cover = await readImage(input.files[0], 900);
      save();
      if (type === "project") home();
      else openFolderView();
    } catch {
      alert("Não foi possível carregar a miniatura.");
    }
  };

  actions.append(button, input);

  if (type === "workspace") {
    const duplicate = document.createElement("button");
    duplicate.className = "secondary duplicate-workspace";
    duplicate.textContent = "Duplicar workspace";
    duplicate.onclick = () => {
      const copy = cloneNodeWithFreshIds(item);
      copy.name = `${item.name} (cópia)`;
      container().children.push(copy);
      save();
      openFolderView();
    };
    actions.append(duplicate);
  }

  el.append(cover, info, actions);
  return el;
}

function home() {
  projectId = null;
  currentId = null;
  selected = null;
  selectedIds.clear();

  showView("projectsView");
  updateHeader();
  $("tree").innerHTML = "";

  const grid = $("projectGrid");
  grid.innerHTML = "";

  if (!data.projects.length) {
    grid.innerHTML =
      '<div class="empty">Crie seu primeiro projeto.</div>';
  }

  data.projects.forEach(p => {
    grid.append(
      makeCard(p, "project", () => openProject(p.id))
    );
  });

  closeMobileSidebar();
}

$("homeBtn").onclick = home;

$("newProjectBtn").onclick = () => {
  openDialog("Novo projeto", "", name => {
    const p = {
      id: uid(), name, cover: null, children: []
    };
    data.projects.push(p);
    save();
    openProject(p.id);
  });
};

function openProject(id) {
  projectId = id;
  currentId = null;
  openFolderView();
}

function openNode(id) {
  currentId = id;
  if (currentNode()?.type === "workspace") {
    openWorkspace(true);
  } else {
    openFolderView();
  }
}

function renderTree() {
  const tree = $("tree");
  tree.innerHTML = "";

  const p = project();
  if (!p) return;

  const root = document.createElement("button");
  root.className = "tree-item";
  root.textContent = "▣ " + p.name;
  root.onclick = () => {
    currentId = null;
    openFolderView();
  };
  tree.append(root);

  function walk(nodes, depth) {
    nodes.forEach(n => {
      const b = document.createElement("button");
      b.className = "tree-item";
      b.style.paddingLeft = 12 + depth * 13 + "px";
      b.textContent =
        (n.type === "folder" ? "▸ " : "▧ ") + n.name;
      b.title = n.name;
      b.classList.toggle("active", n.id === currentId);
      b.onclick = () => openNode(n.id);
      tree.append(b);

      if (n.type === "folder") {
        walk(n.children, depth + 1);
      }
    });
  }

  walk(p.children, 1);
}

function openFolderView() {
  showView("folderView");
  updateHeader();
  renderTree();

  const parent = container();
  if (!parent) return home();

  $("folderTitle").textContent = parent.name;

  const grid = $("folderGrid");
  grid.innerHTML = "";

  const children = parent.children || [];
  if (!children.length) {
    grid.innerHTML =
      '<div class="empty">Esta pasta está vazia.</div>';
  }

  [...children]
    .sort((a, b) =>
      a.type === b.type ? 0 :
      a.type === "folder" ? -1 : 1
    )
    .forEach(n => {
      grid.append(
        makeCard(n, n.type, () => openNode(n.id))
      );
    });

  closeMobileSidebar();
}

$("newFolderBtn").onclick = () => {
  openDialog("Nova pasta", "", name => {
    container().children.push(makeFolder(name));
    save();
    openFolderView();
  });
};

$("newWorkspaceBtn").onclick = () => {
  openDialog("Novo workspace", "", name => {
    const w = makeWorkspace(name);
    container().children.push(w);
    save();
    openNode(w.id);
  });
};

$("renameBtn").onclick = () => {
  const target = currentNode() || project();
  if (!target) return;

  openDialog("Renomear", target.name, name => {
    target.name = name;
    save();
    if (workspace()) openWorkspace(false);
    else openFolderView();
  });
};

$("deleteBtn").onclick = () => {
  const target = currentNode() || project();
  if (!target ||
      !confirm(`Excluir "${target.name}" e tudo dentro?`)) {
    return;
  }

  if (!currentId) {
    data.projects = data.projects.filter(
      p => p.id !== projectId
    );
    save();
    home();
  } else {
    removeNode(project().children, currentId);
    currentId = null;
    save();
    openFolderView();
  }
};

$("aboutBtn").onclick = () => {
  showView("aboutView");
  $("breadcrumbs").textContent = "Sobre o Amophor";
  $("renameBtn").classList.add("hidden");
  $("deleteBtn").classList.add("hidden");
  closeMobileSidebar();
};

// BARRAS RETRÁTEIS

function isMobile() {
  return matchMedia("(max-width: 600px)").matches;
}

function closeMobileSidebar() {
  if (isMobile()) $("app").classList.add("collapsed");
}


$("sidebarBtn").onclick = () => {
  const app = $("app");

  if (app.classList.contains("sidebar-hidden")) {
    app.classList.remove("sidebar-hidden", "collapsed");
  } else if (isMobile()) {
    app.classList.toggle("collapsed");
  } else if (app.classList.contains("collapsed")) {
    app.classList.add("sidebar-hidden");
  } else {
    app.classList.add("collapsed");
  }

  localStorage.setItem(
    "amophor_sidebar",
    app.classList.contains("collapsed") ? "1" : "0"
  );

  localStorage.setItem(
    "amophor_sidebar_hidden",
    app.classList.contains("sidebar-hidden") ? "1" : "0"
  );

  updateFloatingButtons();
};

if (
  isMobile() ||
  localStorage.getItem("amophor_sidebar") === "1"
) {
  $("app").classList.add("collapsed");
}


function toggleBar(id, buttonId, key, upWhenOpen) {
  const collapsed =
    $(id).classList.toggle("is-collapsed");

  $(buttonId).textContent = collapsed
    ? (upWhenOpen ? "▼" : "▲")
    : (upWhenOpen ? "▲" : "▼");

  localStorage.setItem(key, collapsed ? "1" : "0");
}

$("collapseTopBtn").onclick = () =>
  toggleBar(
    "workspaceTop", "collapseTopBtn",
    "amophor_top_collapsed", true
  );

$("collapseBottomBtn").onclick = () =>
  toggleBar(
    "workspaceFooter", "collapseBottomBtn",
    "amophor_bottom_collapsed", false
  );

if (localStorage.getItem("amophor_top_collapsed") === "1") {
  $("workspaceTop").classList.add("is-collapsed");
  $("collapseTopBtn").textContent = "▼";
}

if (localStorage.getItem("amophor_bottom_collapsed") === "1") {
  $("workspaceFooter").classList.add("is-collapsed");
  $("collapseBottomBtn").textContent = "▲";
}

// MODO FOCO E BARRA TOTALMENTE OCULTA

function updateFloatingButtons() {
  const app = $("app");
  const focusing = app.classList.contains("focus-mode");
  const hidden = app.classList.contains("sidebar-hidden");

  $("focusExitBtn").classList.toggle("hidden", !focusing);
  $("reopenSidebarBtn").classList.toggle(
    "hidden", focusing || !hidden
  );
}

function setFocusMode(enabled) {
  if (enabled && !workspace()) return;
  $("app").classList.toggle("focus-mode", enabled);
  updateFloatingButtons();
}

$("focusBtn").onclick = () =>
  setFocusMode(!$("app").classList.contains("focus-mode"));

$("focusExitBtn").onclick = () => setFocusMode(false);


$("reopenSidebarBtn").onclick = () => {
  $("app").classList.remove("sidebar-hidden");
  localStorage.setItem("amophor_sidebar_hidden", "0");
  updateFloatingButtons();
};

if (localStorage.getItem("amophor_sidebar_hidden") === "1") {
  $("app").classList.add("sidebar-hidden");
}

document.addEventListener("keydown", e => {
  if (e.altKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    setFocusMode(!$("app").classList.contains("focus-mode"));
  }
});

updateFloatingButtons();

// WORKSPACE E CÂMERA

function openWorkspace(reset = false) {
  const w = workspace();
  if (!w) return openFolderView();

  showView("workspaceView");
  updateHeader();
  renderTree();

  $("workspaceLabel").textContent = w.name;
  selected = null;
  selectedIds.clear();
  connectFrom = null;
  history = [];

  setTool("select");
  renderObjects();
  redraw();
  closeMobileSidebar();

  if (reset) requestAnimationFrame(centerView);
  else updateCamera();
}

function updateCamera() {
  board.style.transform =
    `translate(${panX}px,${panY}px) scale(${zoom})`;
  $("zoomLabel").textContent =
    Math.round(zoom * 100) + "%";
}

function centerView() {
  zoom = Math.max(
    .15,
    Math.min(
      .75,
      viewport.clientWidth / 1300,
      viewport.clientHeight / 900
    )
  );

  panX = viewport.clientWidth / 2 - W * zoom / 2;
  panY = viewport.clientHeight / 2 - H * zoom / 2;
  updateCamera();
}

function setZoom(value, clientX, clientY) {
  const r = viewport.getBoundingClientRect();
  const x = (clientX ?? r.left + r.width / 2) - r.left;
  const y = (clientY ?? r.top + r.height / 2) - r.top;
  const wx = (x - panX) / zoom;
  const wy = (y - panY) / zoom;

  zoom = Math.max(.15, Math.min(2.5, value));
  panX = x - wx * zoom;
  panY = y - wy * zoom;
  updateCamera();
}

$("zoomIn").onclick = () => setZoom(zoom * 1.2);
$("zoomOut").onclick = () => setZoom(zoom / 1.2);
$("resetView").onclick = centerView;

viewport.addEventListener("wheel", e => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    setZoom(
      zoom * (e.deltaY < 0 ? 1.1 : .9),
      e.clientX, e.clientY
    );
  } else {
    panX -= e.deltaX;
    panY -= e.deltaY;
    updateCamera();
  }
}, { passive: false });

function point(e) {
  const r = viewport.getBoundingClientRect();
  return {
    x: (e.clientX - r.left - panX) / zoom,
    y: (e.clientY - r.top - panY) / zoom
  };
}

function centerPoint() {
  return {
    x: (viewport.clientWidth / 2 - panX) / zoom - 160,
    y: (viewport.clientHeight / 2 - panY) / zoom - 110
  };
}

// DESFAZER

function remember() {
  if (!workspace()) return;

  history.push(JSON.stringify({
    objects: workspace().objects,
    strokes: workspace().strokes,
    connections: workspace().connections,
    cells: workspace().cells
  }));

  if (history.length > 40) history.shift();
}

function undo() {
  if (!workspace() || !history.length) return;

  Object.assign(workspace(), JSON.parse(history.pop()));
  selected = null;
  selectedIds.clear();
  connectFrom = null;
  save();
  renderObjects();
  redraw();
}

function copySelection() {
  const w = workspace();
  if (!w || !selectedIds.size) return;

  clipboard = {
    objects: w.objects.filter(o => selectedIds.has(o.id))
      .map(o => JSON.parse(JSON.stringify(o))),
    cells: w.cells.filter(c => selectedIds.has(`cell:${c.id}`))
      .map(c => JSON.parse(JSON.stringify(c))),
    strokes: w.strokes.filter(s => selectedIds.has(`stroke:${s.id}`))
      .map(s => JSON.parse(JSON.stringify(s))),
    connections: w.connections.filter(c =>
      selectedIds.has(c.from) && selectedIds.has(c.to)
    ).map(c => JSON.parse(JSON.stringify(c)))
  };

  pasteOffset = 0;
}

function pasteSelection() {
  const w = workspace();
  if (!w || !clipboard) return;

  remember();
  pasteOffset += 40;
  const dx = pasteOffset;
  const idMap = new Map();
  const pastedIds = new Set();

  for (const original of clipboard.objects) {
    const item = JSON.parse(JSON.stringify(original));
    const previousId = item.id;
    item.id = uid();
    idMap.set(previousId, item.id);
    item.x += dx;
    item.y += dx;
    w.objects.push(item);
    pastedIds.add(item.id);
  }

  for (const original of clipboard.cells) {
    const cell = { ...original, id: uid(), x: original.x + dx / CELL, y: original.y + dx / CELL };
    w.cells.push(cell);
    pastedIds.add(`cell:${cell.id}`);
  }

  for (const original of clipboard.strokes) {
    const item = JSON.parse(JSON.stringify(original));
    item.id = uid();
    item.points = item.points.map(p => ({ x: p.x + dx, y: p.y + dx }));
    w.strokes.push(item);
    pastedIds.add(`stroke:${item.id}`);
  }

  for (const original of clipboard.connections) {
    const from = idMap.get(original.from);
    const to = idMap.get(original.to);
    if (from && to) w.connections.push({ id: uid(), from, to });
  }

  selectedIds = pastedIds;
  selected = pastedIds.size === 1 ? [...pastedIds][0] : null;
  save();
  redraw();
  renderObjects();
}

$("undoBtn").onclick = undo;

document.addEventListener("keydown", e => {
  const editing = ["INPUT", "TEXTAREA", "SELECT"].includes(
    document.activeElement?.tagName
  );
  const key = e.key.toLowerCase();
  const hasModifier = e.ctrlKey || e.metaKey || e.altKey;

  if (
    (e.ctrlKey || e.metaKey) &&
    e.key.toLowerCase() === "z" &&
    !editing
  ) {
    e.preventDefault();
    undo();
  }

  if ((e.ctrlKey || e.metaKey) && key === "c" && !editing) {
    if (selectedIds.size) {
      e.preventDefault();
      copySelection();
    }
  }

  if ((e.ctrlKey || e.metaKey) && key === "v" && !editing) {
    if (clipboard && workspace()) {
      e.preventDefault();
      pasteSelection();
    }
  }

  if (
    ["Delete", "Backspace"].includes(e.key) &&
    !editing && (selected || selectedIds.size)
  ) {
    e.preventDefault();
    deleteSelected();
  }

  if (e.key === "Escape" && !editing) {
    setTool("select");
    selectedIds.clear();
    selected = null;
    connectFrom = null;
    $("shapeMenu").open = false;
    renderObjects();
    redraw();
    return;
  }

  if (!editing && !hasModifier && workspace()) {
    if (key === "d") setTool("pen");
    else if (key === "e") setTool("eraser");
    else if (key === "p") setTool("grid");
    else if (key === "v") setTool("eyedropper");
    else if (key === "c") $("colorPicker").click();
    else if (key === "i") $("imageInput").click();
    else if (key === "t") addObject("text");
  }
});

// FERRAMENTAS

function setTool(value) {
  tool = value;
  connectFrom = null;

  document.querySelectorAll("[data-tool]").forEach(b => {
    b.classList.toggle("active", b.dataset.tool === value);
  });

  const drawing = ["pen", "eraser", "grid"].includes(value);
  canvas.style.pointerEvents =
    drawing || ["select", "lasso", "eyedropper"].includes(value)
      ? "auto"
      : "none";

  viewport.style.cursor =
    value === "pen" ? "crosshair" :
    value === "eraser" ? "cell" :
    value === "grid" ? "crosshair" :
    value === "eyedropper" ? "copy" :
    value === "lasso" ? "crosshair" : "default";

  if (workspace()) renderObjects();
}

document.querySelectorAll("[data-tool]").forEach(b => {
  b.onclick = () => setTool(b.dataset.tool);
});

// CRIAR OBJETOS

function addObject(type) {
  if (!workspace()) return;
  remember();

  if (["rect", "circle", "line"].includes(type)) {
    $("shapeMenu").open = false;
  }

  const p = centerPoint();
  const o = {
    id: uid(),
    type,
    x: p.x,
    y: p.y,
    w: 320,
    h: 230,
    color: $("colorPicker").value
  };

  if (type === "text") {
    Object.assign(o, {
      title: "Nova anotação",
      text: "",
      minimized: false,
      fontSize: 17,
      transparent: false,
      h: 260,
      color: "#302a36"
    });
  }

  if (type === "rect") o.h = 180;
  if (type === "circle") o.w = o.h = 190;

  if (type === "line") {
    o.w = 250;
    o.h = 120;
  }

  workspace().objects.push(o);
  selected = o.id;
  selectedIds = new Set([o.id]);
  setTool("select");
  save();
  renderObjects();
}

$("addText").onclick = () => addObject("text");
$("addRect").onclick = () => addObject("rect");
$("addCircle").onclick = () => addObject("circle");
$("addLine").onclick = () => addObject("line");

function deleteSelected() {
  if (!workspace() || (!selected && !selectedIds.size)) return;

  remember();

  const ids = new Set(selectedIds);

  if (selected && !selected.startsWith("connection:")) {
    ids.add(selected);
  }

  if (selected?.startsWith("connection:")) {
    workspace().connections = workspace().connections.filter(
      c => c.id !== selected.slice(11)
    );
  }

  if (ids.size) {
    workspace().objects = workspace().objects.filter(
      o => !ids.has(o.id)
    );

    workspace().strokes = workspace().strokes.filter(
      s => !ids.has(`stroke:${s.id}`)
    );

    workspace().cells = workspace().cells.filter(
      c => !ids.has(`cell:${c.id}`)
    );

    workspace().connections = workspace().connections.filter(
      c => !ids.has(c.from) && !ids.has(c.to)
    );
  }

  selected = null;
  selectedIds.clear();
  save();
  renderObjects();
  redraw();
}

$("deleteObject").onclick = deleteSelected;

function select(id, additive = false) {
  if (!additive) selectedIds.clear();

  if (additive && selectedIds.has(id)) {
    selectedIds.delete(id);
  } else {
    selectedIds.add(id);
  }

  selected = selectedIds.size === 1
    ? [...selectedIds][0]
    : null;

  renderObjects();
  redraw();
}

function groupBounds() {
  const objects = workspace()?.objects.filter(
    o => selectedIds.has(o.id)
  ) || [];

  if (!objects.length) return null;

  const x = Math.min(...objects.map(o => o.x));
  const y = Math.min(...objects.map(o => o.y));
  const right = Math.max(...objects.map(o => o.x + o.w));
  const bottom = Math.max(...objects.map(o => o.y + o.h));

  return {
    x,
    y,
    w: right - x,
    h: bottom - y
  };
}

function selectionBounds() {
  const bounds = [];
  const w = workspace();
  if (!w) return null;

  for (const o of w.objects) {
    if (selectedIds.has(o.id)) {
      bounds.push({ x: o.x, y: o.y, w: o.w, h: o.h });
    }
  }

  for (const cell of w.cells) {
    if (selectedIds.has(`cell:${cell.id}`)) {
      bounds.push({
        x: cell.x * CELL,
        y: cell.y * CELL,
        w: CELL,
        h: CELL
      });
    }
  }

  for (const s of w.strokes) {
    if (!selectedIds.has(`stroke:${s.id}`) || !s.points?.length) {
      continue;
    }

    const pad = (s.size || 4) / 2;
    const xs = s.points.map(p => p.x);
    const ys = s.points.map(p => p.y);
    const x = Math.min(...xs) - pad;
    const y = Math.min(...ys) - pad;
    bounds.push({
      x,
      y,
      w: Math.max(1, Math.max(...xs) - Math.min(...xs) + pad * 2),
      h: Math.max(1, Math.max(...ys) - Math.min(...ys) + pad * 2)
    });
  }

  if (!bounds.length) return null;

  const x = Math.min(...bounds.map(b => b.x));
  const y = Math.min(...bounds.map(b => b.y));
  const right = Math.max(...bounds.map(b => b.x + b.w));
  const bottom = Math.max(...bounds.map(b => b.y + b.h));
  return { x, y, w: right - x, h: bottom - y };
}

function updateSelectionBox() {
  const box = $("selectionBox");
  if (!box) return;

  const b = selectionBounds();
  const onlyObjects = [...selectedIds].every(id =>
    workspace()?.objects.some(o => o.id === id)
  );

  box.classList.toggle(
    "hidden",
    !b ||
    selectedIds.size < 2 ||
    !onlyObjects ||
    !["select", "lasso"].includes(tool)
  );

  if (!b) return;

  Object.assign(box.style, {
    left: b.x + "px",
    top: b.y + "px",
    width: b.w + "px",
    height: b.h + "px"
  });
}

function beginGroupMove(e) {
  const p = point(e);

  remember();

  gesture = {
    kind: "group-move",
    start: p,
    items: [
      ...workspace().objects
        .filter(o => selectedIds.has(o.id))
        .map(o => ({ type: "object", id: o.id, x: o.x, y: o.y })),
      ...workspace().cells
        .filter(c => selectedIds.has(`cell:${c.id}`))
        .map(c => ({ type: "cell", id: c.id, x: c.x, y: c.y })),
      ...workspace().strokes
        .filter(s => selectedIds.has(`stroke:${s.id}`))
        .map(s => ({
          type: "stroke",
          id: s.id,
          points: s.points.map(p => ({ ...p }))
        }))
    ]
  };
}

function moveGroup(e) {
  if (gesture?.kind !== "group-move") return;

  const p = point(e);
  const dx = p.x - gesture.start.x;
  const dy = p.y - gesture.start.y;

  for (const start of gesture.items) {
    if (start.type === "object") {
      const o = workspace().objects.find(x => x.id === start.id);
      if (!o) continue;
      o.x = start.x + dx;
      o.y = start.y + dy;
    } else if (start.type === "cell") {
      const cell = workspace().cells.find(
        c => c.id === start.id
      );
      if (cell) {
        cell.x = Math.round(start.x + dx / CELL);
        cell.y = Math.round(start.y + dy / CELL);
      }
    } else if (start.type === "stroke") {
      const s = workspace().strokes.find(x => x.id === start.id);
      if (s) {
        s.points = start.points.map(p => ({
          x: p.x + dx,
          y: p.y + dy
        }));
      }
    }
  }

  syncObjectPositions();
  redraw();
}

function syncObjectPositions() {
  for (const o of workspace()?.objects || []) {
    const el = [...layer.children].find(
      x => x.dataset.id === o.id
    );

    if (!el) continue;

    el.style.left = o.x + "px";
    el.style.top = o.y + "px";
    el.style.width = o.w + "px";
    el.style.height = o.h + "px";
  }

  updateSelectionBox();
  renderConnections();
}

// REDIMENSIONAR VÁRIOS OBJETOS

function setupGroupHandle() {
  const handle = $("groupResizeHandle");
  if (!handle) return;

  handle.onpointerdown = e => {
    e.stopPropagation();
    e.preventDefault();

    if (selectedIds.size < 2) return;

    remember();

    gesture = {
      kind: "group-resize",
      bounds: groupBounds(),
      items: workspace().objects
        .filter(o => selectedIds.has(o.id))
        .map(o => ({
          id: o.id,
          x: o.x,
          y: o.y,
          w: o.w,
          h: o.h
        }))
    };

    handle.setPointerCapture(e.pointerId);
  };

  handle.onpointermove = e => {
    if (gesture?.kind !== "group-resize") return;

    const p = point(e);
    const b = gesture.bounds;

    const sx = Math.max(
      .1,
      (p.x - b.x) / Math.max(1, b.w)
    );

    const sy = Math.max(
      .1,
      (p.y - b.y) / Math.max(1, b.h)
    );

    for (const a of gesture.items) {
      const o = workspace().objects.find(
        x => x.id === a.id
      );

      if (!o) continue;

      o.x = b.x + (a.x - b.x) * sx;
      o.y = b.y + (a.y - b.y) * sy;
      o.w = Math.max(30, a.w * sx);
      o.h = Math.max(25, a.h * sy);
    }

    syncObjectPositions();
  };

  handle.onpointerup = handle.onpointercancel = () => {
    if (gesture?.kind === "group-resize") {
      gesture = null;
      save();
      renderObjects();
    }
  };
}

// CONEXÕES

function connectClick(id) {
  if (!connectFrom) {
    connectFrom = id;
    renderObjects();
    return;
  }

  if (connectFrom === id) {
    connectFrom = null;
    renderObjects();
    return;
  }

  const exists = workspace().connections.some(c =>
    (c.from === connectFrom && c.to === id) ||
    (c.from === id && c.to === connectFrom)
  );

  if (!exists) {
    remember();

    workspace().connections.push({
      id: uid(),
      from: connectFrom,
      to: id
    });

    save();
  }

  connectFrom = null;
  renderObjects();
}

function renderConnections() {
  lines.replaceChildren();

  if (!workspace()) return;

  const lookup = new Map(
    workspace().objects.map(o => [o.id, o])
  );

  for (const c of workspace().connections) {
    const a = lookup.get(c.from);
    const b = lookup.get(c.to);

    if (!a || !b) continue;

    const el = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "line"
    );

    el.setAttribute("x1", a.x + a.w / 2);
    el.setAttribute("y1", a.y + a.h / 2);
    el.setAttribute("x2", b.x + b.w / 2);
    el.setAttribute("y2", b.y + b.h / 2);

    el.setAttribute(
      "class",
      "connection-line" +
      (selected === "connection:" + c.id
        ? " selected"
        : "")
    );

    el.style.pointerEvents =
      tool === "select" ? "stroke" : "none";

    el.onpointerdown = e => {
      if (tool !== "select") return;

      e.stopPropagation();
      selected = "connection:" + c.id;
      renderObjects();
    };

    lines.append(el);
  }
}

// RENDERIZAÇÃO DOS ELEMENTOS

function renderObjects() {
  layer.replaceChildren();

  if (!workspace()) return;

  renderConnections();

  for (const o of workspace().objects) {
    const el = document.createElement("div");

    el.className =
      "workspace-object " + o.type + "-object";

    el.dataset.id = o.id;

    el.classList.toggle(
      "selected",
      selectedIds.has(o.id)
    );

    el.classList.toggle(
      "connect-source",
      connectFrom === o.id
    );

    function updateStyle() {
      el.style.left = o.x + "px";
      el.style.top = o.y + "px";
      el.style.width = o.w + "px";
      el.style.height = o.h + "px";
    }

    updateStyle();

    // IMAGENS

    if (o.type === "image") {
      const img = document.createElement("img");
      img.src = o.src;
      img.draggable = false;
      el.append(img);
    }

    // ANOTAÇÕES

    if (o.type === "text") {
      const color = validColor(o.color, "#302a36");

      const textColor = isDarkColor(color)
        ? "#f8f5f9"
        : "#1c1720";

      el.style.background = color;
      el.style.color = o.transparent
        ? "var(--text)"
        : textColor;

      el.classList.toggle(
        "transparent-note",
        !!o.transparent
      );

      const bar = document.createElement("div");
      bar.className = "object-titlebar";

      const title = document.createElement("span");
      title.className = "note-title";
      title.textContent = o.title || "Anotação";

      title.ondblclick = e => {
        e.stopPropagation();

        openDialog("Título do bloco", o.title, name => {
          o.title = name;
          save();
          renderObjects();
        });
      };

      const controls = document.createElement("div");
      controls.className = "note-controls";

      function control(label, tooltip, callback) {
        const b = document.createElement("button");

        b.type = "button";
        b.textContent = label;
        b.title = tooltip;

        b.onpointerdown = e => e.stopPropagation();

        b.onclick = e => {
          e.stopPropagation();
          callback();
        };

        controls.append(b);
        return b;
      }

      // COR DO BLOCO

      const picker = document.createElement("input");
      picker.type = "color";
      picker.value = color;
      picker.title = "Cor do bloco";

      picker.onpointerdown = e => e.stopPropagation();
      picker.onclick = e => e.stopPropagation();

      let savedColorHistory = false;

      picker.oninput = e => {
        if (!savedColorHistory) {
          remember();
          savedColorHistory = true;
        }

        o.color = e.target.value;
        el.style.background = o.color;

        el.style.color = o.transparent
          ? "var(--text)"
          : isDarkColor(o.color)
            ? "#f8f5f9"
            : "#1c1720";

        save();
      };

      picker.onchange = () => {
        savedColorHistory = false;
        renderObjects();
      };

      controls.append(picker);

      // TAMANHO DA FONTE

      control("A−", "Diminuir fonte", () => {
        remember();
        o.fontSize = Math.max(
          10,
          (o.fontSize || 17) - 2
        );
        save();
        renderObjects();
      });

      control("A+", "Aumentar fonte", () => {
        remember();
        o.fontSize = Math.min(
          64,
          (o.fontSize || 17) + 2
        );
        save();
        renderObjects();
      });

      // FUNDO TRANSPARENTE

      control(
        o.transparent ? "▣" : "◫",
        o.transparent
          ? "Mostrar fundo"
          : "Deixar somente as letras",
        () => {
          remember();
          o.transparent = !o.transparent;
          save();
          renderObjects();
        }
      );

      // MINIMIZAR

      control(
        o.minimized ? "□" : "−",
        o.minimized ? "Expandir" : "Minimizar",
        () => {
          remember();
          o.minimized = !o.minimized;

          if (o.minimized) {
            o.expandedHeight = o.h;
            o.h = 100;
          } else {
            o.h = o.expandedHeight || 260;
          }

          save();
          renderObjects();
        }
      );

      bar.append(title, controls);
      el.append(bar);

      if (o.minimized) {
        const preview = document.createElement("div");
        preview.className = "text-preview";

        preview.textContent =
          o.text || "Anotação minimizada";

        preview.style.fontSize =
          Math.max(10, (o.fontSize || 17) - 2) + "px";

        preview.ondblclick = () => {
          remember();
          o.minimized = false;
          o.h = o.expandedHeight || 260;
          save();
          renderObjects();
        };

        el.append(preview);
      } else {
        const textarea = document.createElement("textarea");

        textarea.className = "text-body";
        textarea.placeholder = "Escreva suas ideias...";
        textarea.value = o.text || "";
        textarea.style.fontSize =
          (o.fontSize || 17) + "px";

        textarea.onpointerdown = e =>
          e.stopPropagation();

        textarea.oninput = () => {
          o.text = textarea.value;
          save();
        };

        el.append(textarea);
      }
    }

    // FORMAS GEOMÉTRICAS

    if (["rect", "circle", "line"].includes(o.type)) {
      const svg = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg"
      );

      svg.setAttribute("viewBox", "0 0 100 100");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.classList.add("shape-visual");

      const color = validColor(o.color);

      if (o.type === "rect") {
        svg.innerHTML = `
          <rect x="3" y="3" width="94" height="94"
            fill="none" stroke="${color}"
            stroke-width="3"/>
        `;
      } else if (o.type === "circle") {
        svg.innerHTML = `
          <ellipse cx="50" cy="50" rx="47" ry="47"
            fill="none" stroke="${color}"
            stroke-width="3"/>
        `;
      } else {
        svg.innerHTML = `
          <line x1="3" y1="97" x2="97" y2="3"
            stroke="${color}" stroke-width="3"/>
        `;
      }

      el.append(svg);
    }

    // ARRASTAR

    el.onpointerdown = e => {
      if (e.button !== 0) return;

      if (tool === "eyedropper") {
        e.stopPropagation();
        setPickedColor(o.color || $("colorPicker").value);
        return;
      }

      if (tool === "connect") {
        e.stopPropagation();
        connectClick(o.id);
        return;
      }

      if (!["select", "lasso"].includes(tool)) return;

      if (e.target.closest(
        "textarea,button,input,.resize-handle"
      )) return;

      e.stopPropagation();

      if (e.shiftKey) {
        select(o.id, true);
        return;
      }

      if (tool === "lasso" && !selectedIds.has(o.id)) {
        select(o.id);
        return;
      }

      if (
        selectedIds.size > 1 &&
        selectedIds.has(o.id)
      ) {
        beginGroupMove(e);
        el.setPointerCapture(e.pointerId);
        return;
      }

      remember();

      selectedIds = new Set([o.id]);
      selected = o.id;
      renderSelectionOnly();

      const p = point(e);

      gesture = {
        kind: "move",
        id: o.id,
        dx: p.x - o.x,
        dy: p.y - o.y
      };

      el.setPointerCapture(e.pointerId);
    };

    el.onpointermove = e => {
      if (gesture?.kind === "group-move") {
        moveGroup(e);
        return;
      }

      if (
        gesture?.kind !== "move" ||
        gesture.id !== o.id
      ) return;

      const p = point(e);

      o.x = p.x - gesture.dx;
      o.y = p.y - gesture.dy;

      updateStyle();
      renderConnections();
    };

    function finishMove() {
      if (gesture?.kind === "group-move") {
        gesture = null;
        save();
        renderObjects();
        return;
      }

      if (
        gesture?.kind === "move" &&
        gesture.id === o.id
      ) {
        gesture = null;
        save();
        renderObjects();
      }
    }

    el.onpointerup = finishMove;
    el.onpointercancel = finishMove;

    // REDIMENSIONAR

    if (selected === o.id && tool === "select") {
      const handle = document.createElement("div");
      handle.className = "resize-handle";

      handle.onpointerdown = e => {
        e.stopPropagation();
        remember();

        gesture = {
          kind: "resize",
          id: o.id
        };

        handle.setPointerCapture(e.pointerId);
      };

      handle.onpointermove = e => {
        if (
          gesture?.kind !== "resize" ||
          gesture.id !== o.id
        ) return;

        const p = point(e);

        o.w = Math.max(80, p.x - o.x);
        o.h = Math.max(55, p.y - o.y);

        updateStyle();
        renderConnections();
      };

      function finishResize() {
        if (
          gesture?.kind === "resize" &&
          gesture.id === o.id
        ) {
          gesture = null;
          save();
          renderObjects();
        }
      }

      handle.onpointerup = finishResize;
      handle.onpointercancel = finishResize;

      el.append(handle);
    }

    layer.append(el);
  }

  updateSelectionBox();
}

$("colorPicker").onchange = e => {
  const o = workspace()?.objects.find(
    x => x.id === selected
  );

  if (!o) return;

  remember();
  o.color = e.target.value;
  save();
  renderObjects();
};

// IMAGENS

function readImage(file, max = 1500) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("Arquivo inválido"));
      return;
    }

    const reader = new FileReader();
    reader.onerror = reject;

    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;

      img.onload = () => {
        const scale = Math.min(
          1,
          max / Math.max(img.width, img.height)
        );

        const c = document.createElement("canvas");

        c.width = Math.max(
          1,
          Math.round(img.width * scale)
        );

        c.height = Math.max(
          1,
          Math.round(img.height * scale)
        );

        c.getContext("2d").drawImage(
          img, 0, 0, c.width, c.height
        );

        resolve(c.toDataURL("image/jpeg", .8));
      };

      img.src = reader.result;
    };

    reader.readAsDataURL(file);
  });
}

$("addImage").onclick = () => $("imageInput").click();

$("imageInput").onchange = async e => {
  const file = e.target.files[0];
  const target = currentId;

  if (!file || !workspace()) return;

  try {
    const src = await readImage(file);
    const img = new Image();

    img.onload = () => {
      if (currentId !== target || !workspace()) return;

      remember();

      const p = centerPoint();
      const scale = Math.min(
        1,
        400 / img.width,
        300 / img.height
      );

      const o = {
        id: uid(),
        type: "image",
        src,
        x: p.x,
        y: p.y,
        w: img.width * scale,
        h: img.height * scale
      };

      workspace().objects.push(o);
      selected = o.id;
      setTool("select");
      save();
      renderObjects();
    };

    img.src = src;
  } catch {
    alert("Erro ao importar imagem.");
  }

  e.target.value = "";
};



 // DESENHO LIVRE E PIXELS

let marquee = null;

function redraw() {
  ctx.clearRect(0, 0, W, H);

  const w = workspace();
  if (!w) return;

  // Pixels pintados
  for (const cell of w.cells) {
    ctx.fillStyle = validColor(cell.color);
    ctx.fillRect(
      cell.x * CELL,
      cell.y * CELL,
      CELL,
      CELL
    );

    if (selectedIds.has(`cell:${cell.id}`)) {
      ctx.strokeStyle = "#91b49a";
      ctx.lineWidth = 3 / zoom;
      ctx.setLineDash([6 / zoom, 4 / zoom]);
      ctx.strokeRect(
        cell.x * CELL + 1,
        cell.y * CELL + 1,
        CELL - 2,
        CELL - 2
      );
      ctx.setLineDash([]);
    }
  }

  // Desenhos livres
  const strokes = [
    ...w.strokes,
    ...(stroke ? [stroke] : [])
  ];

  for (const s of strokes) {
    if (!s.points?.length) continue;

    const isSelected = selectedIds.has(`stroke:${s.id}`);
    if (isSelected) {
      ctx.strokeStyle = "#91b49a";
      ctx.lineWidth = (s.size || 4) + 7 / zoom;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) {
        ctx.lineTo(s.points[i].x, s.points[i].y);
      }
      if (s.points.length === 1) {
        ctx.arc(
          s.points[0].x,
          s.points[0].y,
          ((s.size || 4) + 7 / zoom) / 2,
          0,
          Math.PI * 2
        );
      }
      ctx.stroke();
    }

    ctx.strokeStyle = s.color || "#805b91";
    ctx.fillStyle = s.color || "#805b91";
    ctx.lineWidth = s.size || 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.beginPath();

    if (s.points.length === 1) {
      const p = s.points[0];

      ctx.arc(
        p.x,
        p.y,
        (s.size || 4) / 2,
        0,
        Math.PI * 2
      );

      ctx.fill();
    } else {
      ctx.moveTo(
        s.points[0].x,
        s.points[0].y
      );

      for (let i = 1; i < s.points.length; i++) {
        ctx.lineTo(
          s.points[i].x,
          s.points[i].y
        );
      }

      ctx.stroke();
    }
  }
}

function paintCell(p) {
  const w = workspace();
  if (!w) return;

  const x = Math.floor(p.x / CELL);
  const y = Math.floor(p.y / CELL);

  if (
    x < 0 ||
    y < 0 ||
    x >= W / CELL ||
    y >= H / CELL
  ) return;

  const color = $("colorPicker").value;

  const existing = w.cells.find(
    c => c.x === x && c.y === y
  );

  if (existing) {
    if (existing.color === color) return;
    existing.color = color;
  } else {
    w.cells.push({ id: uid(), x, y, color });
  }

  redraw();
  save();
}

// BORRACHA DE PARTES DO TRAÇO

function distance(a, b) {
  return Math.hypot(
    a.x - b.x,
    a.y - b.y
  );
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;

  if (!len2) return distance(p, a);

  const t = Math.max(
    0,
    Math.min(
      1,
      (
        (p.x - a.x) * dx +
        (p.y - a.y) * dy
      ) / len2
    )
  );

  return distance(p, {
    x: a.x + dx * t,
    y: a.y + dy * t
  });
}

/*
  Divide o desenho em pequenos trechos.
  Os pontos sob a borracha são removidos.
  O restante continua visível.
*/

function eraseStrokePart(s, center, radius) {
  const points = s.points || [];
  if (!points.length) return [s];

  const samples = [];

  if (points.length === 1) {
    samples.push(points[0]);
  } else {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const length = distance(a, b);

      const steps = Math.max(
        1,
        Math.ceil(length / 3)
      );

      for (let j = 0; j < steps; j++) {
        const t = j / steps;

        samples.push({
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t
        });
      }
    }

    samples.push(points[points.length - 1]);
  }

  const remaining = [];
  let part = [];
  let touched = false;

  const limit = radius + (s.size || 4) / 2;

  function finishPart() {
    if (!part.length) return;

    remaining.push({
      id: uid(),
      color: s.color,
      size: s.size,
      points: part
    });

    part = [];
  }

  for (const p of samples) {
    if (distance(p, center) <= limit) {
      touched = true;
      finishPart();
    } else {
      part.push(p);
    }
  }

  finishPart();

  return touched ? remaining : [s];
}

function eraseAt(p) {
  const w = workspace();
  if (!w) return;

  const radius =
    Number($("brushSize").value) * 1.8 + 4;

  // Apagar células atingidas
  w.cells = w.cells.filter(c => {
    const left = c.x * CELL;
    const top = c.y * CELL;

    const closestX = Math.max(
      left,
      Math.min(p.x, left + CELL)
    );

    const closestY = Math.max(
      top,
      Math.min(p.y, top + CELL)
    );

    return Math.hypot(
      p.x - closestX,
      p.y - closestY
    ) > radius;
  });

  // Apagar partes dos traços
  w.strokes = w.strokes.flatMap(
    s => eraseStrokePart(s, p, radius)
  );

  redraw();
  save();
}

// INTERPOLAÇÃO DO PINCEL

function interpolate(a, b, spacing, callback) {
  const length = distance(a, b);

  const steps = Math.max(
    1,
    Math.ceil(length / spacing)
  );

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;

    callback({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t
    });
  }
}

// EVENTOS DO CANVAS

canvas.onpointerdown = e => {
  if (!workspace() || e.button !== 0) return;

  if (tool === "eyedropper") {
    const color = sampleColorAt(point(e));
    if (color) setPickedColor(color);
    return;
  }

  if (["select", "lasso"].includes(tool)) {
    const p = point(e);
    const hit = hitDrawnElement(p);
    if (!hit) return;

    e.stopPropagation();
    if (e.shiftKey) {
      select(hit.id, true);
      return;
    }

    if (!selectedIds.has(hit.id) || selectedIds.size < 2) {
      selectedIds = new Set([hit.id]);
      selected = hit.id;
      redraw();
    }

    beginGroupMove(e);
    canvas.setPointerCapture(e.pointerId);
    return;
  }

  if (!["pen", "eraser", "grid"].includes(tool)) return;

  remember();

  painting = true;
  lastPaintPoint = point(e);

  canvas.setPointerCapture(e.pointerId);

  if (tool === "pen") {
    stroke = {
      id: uid(),
      color: $("colorPicker").value,
      size: Number($("brushSize").value),
      points: [lastPaintPoint]
    };

    redraw();
  } else if (tool === "eraser") {
    eraseAt(lastPaintPoint);
  } else if (tool === "grid") {
    paintCell(lastPaintPoint);
  }
};

canvas.onpointermove = e => {
  if (gesture?.kind === "group-move") {
    moveGroup(e);
    return;
  }

  if (!painting || !lastPaintPoint) return;

  const next = point(e);
  const previous = lastPaintPoint;

  if (tool === "pen" && stroke) {
    stroke.points.push(next);
    redraw();
  } else if (tool === "eraser") {
    interpolate(
      previous,
      next,
      6,
      eraseAt
    );
  } else if (tool === "grid") {
    interpolate(
      previous,
      next,
      CELL / 4,
      paintCell
    );
  }

  lastPaintPoint = next;
};

function finishDrawing() {
  if (!painting) return;

  if (stroke && workspace()) {
    workspace().strokes.push(stroke);
    stroke = null;
  }

  painting = false;
  lastPaintPoint = null;

  save();
  redraw();
}

function hitDrawnElement(p) {
  const w = workspace();
  if (!w) return null;

  for (let i = w.strokes.length - 1; i >= 0; i--) {
    const s = w.strokes[i];
    const radius = (s.size || 4) / 2 + 8 / zoom;
    const points = s.points || [];
    const hit = points.length === 1
      ? distance(p, points[0]) <= radius
      : points.slice(1).some((next, index) =>
          distanceToSegment(p, points[index], next) <= radius
        );
    if (hit) return { type: "stroke", id: `stroke:${s.id}` };
  }

  for (let i = w.cells.length - 1; i >= 0; i--) {
    const cell = w.cells[i];
    if (
      p.x >= cell.x * CELL && p.x <= (cell.x + 1) * CELL &&
      p.y >= cell.y * CELL && p.y <= (cell.y + 1) * CELL
    ) return { type: "cell", id: `cell:${cell.id}` };
  }

  return null;
}

function sampleColorAt(p) {
  const w = workspace();
  const hit = hitDrawnElement(p);

  if (hit?.type === "cell") {
    return w.cells.find(c => `cell:${c.id}` === hit.id)?.color;
  }

  if (hit?.type === "stroke") {
    return w.strokes.find(s => `stroke:${s.id}` === hit.id)?.color;
  }

  const object = [...w.objects].reverse().find(o =>
    p.x >= o.x && p.x <= o.x + o.w &&
    p.y >= o.y && p.y <= o.y + o.h
  );
  if (object?.color) return object.color;

  const rgb = getComputedStyle(board).backgroundColor.match(/\d+/g);
  return rgb?.length >= 3
    ? "#" + rgb.slice(0, 3).map(value =>
        Number(value).toString(16).padStart(2, "0")
      ).join("")
    : null;
}

function setPickedColor(color) {
  $("colorPicker").value = validColor(color, $("colorPicker").value);
  setTool("select");
}

function finishCanvasGesture() {
  finishDrawing();
  if (gesture?.kind === "group-move") {
    gesture = null;
    save();
    redraw();
    renderObjects();
  }
}

canvas.onpointerup = finishCanvasGesture;
canvas.onpointercancel = finishCanvasGesture;

// MOVER O QUADRO E SELECIONAR POR ÁREA

viewport.onpointerdown = e => {
  if (
    e.target.closest(
      ".workspace-object,.connection-line"
    ) ||
    ["pen", "eraser", "grid"].includes(tool)
  ) return;

  if (tool === "connect") {
    connectFrom = null;
    renderObjects();
    return;
  }

  if (
    tool === "lasso" ||
    (tool === "select" && e.shiftKey)
  ) {
    const start = point(e);

    if (!e.shiftKey) {
      selectedIds.clear();
    }

    selected = null;

    marquee = {
      start,
      end: start
    };

    updateMarquee();

    gesture = {
      kind: "marquee"
    };

    viewport.setPointerCapture(e.pointerId);
    return;
  }

  if (tool === "select") {
    selected = null;
    selectedIds.clear();
    renderObjects();
  }

  gesture = {
    kind: "pan",
    x: e.clientX,
    y: e.clientY,
    startX: panX,
    startY: panY
  };

  viewport.setPointerCapture(e.pointerId);
};

viewport.onpointermove = e => {
  if (
    gesture?.kind === "marquee" &&
    marquee
  ) {
    marquee.end = point(e);
    updateMarquee();
    return;
  }

  if (gesture?.kind !== "pan") return;

  panX =
    gesture.startX +
    e.clientX -
    gesture.x;

  panY =
    gesture.startY +
    e.clientY -
    gesture.y;

  updateCamera();
};

function finishPan() {
  if (
    gesture?.kind === "marquee" &&
    marquee
  ) {
    const a = marquee.start;
    const b = marquee.end;

    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const bottom = Math.max(a.y, b.y);

    for (const o of workspace()?.objects || []) {
      const intersects =
        o.x < right &&
        o.x + o.w > left &&
        o.y < bottom &&
        o.y + o.h > top;

      if (intersects) {
        selectedIds.add(o.id);
      }
    }

    for (const cell of workspace()?.cells || []) {
      const x = cell.x * CELL;
      const y = cell.y * CELL;
      if (x < right && x + CELL > left && y < bottom && y + CELL > top) {
        selectedIds.add(`cell:${cell.id}`);
      }
    }

    for (const s of workspace()?.strokes || []) {
      const bounds = strokeBounds(s);
      if (bounds && bounds.x < right && bounds.x + bounds.w > left &&
          bounds.y < bottom && bounds.y + bounds.h > top) {
        selectedIds.add(`stroke:${s.id}`);
      }
    }

    selected = selectedIds.size === 1
      ? [...selectedIds][0]
      : null;

    marquee = null;

    $("marqueeBox").classList.add("hidden");

    gesture = null;
    renderObjects();
    redraw();
    return;
  }

  if (gesture?.kind === "pan") {
    gesture = null;
  }
}

function updateMarquee() {
  const el = $("marqueeBox");
  if (!el || !marquee) return;

  const a = marquee.start;
  const b = marquee.end;

  el.classList.remove("hidden");

  Object.assign(el.style, {
    left: Math.min(a.x, b.x) + "px",
    top: Math.min(a.y, b.y) + "px",
    width: Math.abs(a.x - b.x) + "px",
    height: Math.abs(a.y - b.y) + "px"
  });
}

function strokeBounds(s) {
  if (!s.points?.length) return null;
  const pad = (s.size || 4) / 2;
  const xs = s.points.map(p => p.x);
  const ys = s.points.map(p => p.y);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return {
    x,
    y,
    w: Math.max(1, Math.max(...xs) - Math.min(...xs) + pad * 2),
    h: Math.max(1, Math.max(...ys) - Math.min(...ys) + pad * 2)
  };
}

function renderSelectionOnly() {
  for (const el of layer.children) {
    el.classList.toggle(
      "selected",
      selectedIds.has(el.dataset.id)
    );
  }

  updateSelectionBox();
  renderConnections();
  redraw();
}

viewport.onpointerup = finishPan;
viewport.onpointercancel = finishPan;

// TEMA

function setTheme(theme) {
  document.body.dataset.theme = theme;

  $("themeBtn").innerHTML =
    theme === "dark"
      ? '☀ <span class="nav-label">Tema claro</span>'
      : '☾ <span class="nav-label">Tema escuro</span>';

  localStorage.setItem(
    "amophor_theme",
    theme
  );
}

$("themeBtn").onclick = () => {
  setTheme(
    document.body.dataset.theme === "dark"
      ? "light"
      : "dark"
  );
};

// INICIALIZAÇÃO

setTheme(
  localStorage.getItem("amophor_theme") || "dark"
);

setTool("select");
home();
setupGroupHandle();
