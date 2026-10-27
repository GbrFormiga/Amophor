
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
    // Oculto → Normal
    app.classList.remove("sidebar-hidden", "collapsed");
  } else if (app.classList.contains("collapsed")) {
    // Compacto → Oculto
    app.classList.add("sidebar-hidden");
  } else {
    // Normal → Compacto
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

$("undoBtn").onclick = undo;

document.addEventListener("keydown", e => {
  const editing = ["INPUT", "TEXTAREA"].includes(
    document.activeElement?.tagName
  );

  if (
    (e.ctrlKey || e.metaKey) &&
    e.key.toLowerCase() === "z" &&
    !editing
  ) {
    e.preventDefault();
    undo();
  }

  if (
    ["Delete", "Backspace"].includes(e.key) &&
    !editing && (selected || selectedIds.size)
  ) {
    e.preventDefault();
    deleteSelected();
  }

  if (e.key === "Escape" && !editing && selectedIds.size) {
    selectedIds.clear();
    selected = null;
    renderObjects();
  }

  if (e.key === "Escape" && connectFrom) {
    connectFrom = null;
    renderObjects();
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
  canvas.style.pointerEvents = drawing ? "auto" : "none";

  viewport.style.cursor =
    value === "pen" ? "crosshair" :
    value === "eraser" ? "cell" :
    value === "grid" ? "crosshair" :
    value === "pan" ? "grab" :
    value === "lasso" ? "crosshair" : "default";

  const hint = $("toolHint");
  hint.classList.toggle(
    "hidden",
    !["connect", "eraser", "grid", "lasso"].includes(value)
  );

  if (value === "lasso") {
    hint.textContent =
      "Arraste uma área para selecionar vários elementos. " +
      "Shift + clique adiciona ou remove.";
  } else if (value === "connect") {
    hint.textContent =
      "Clique em dois elementos para conectá-los.";
  } else if (value === "eraser") {
    hint.textContent =
      "Arraste a borracha para apagar partes dos desenhos.";
  } else if (value === "grid") {
    hint.textContent =
      "Pinte quadradinhos alinhados à grade de 40 × 40.";
  }

  if (workspace()) renderObjects();
}

document.querySelectorAll("[data-tool]").forEach(b => {
  b.onclick = () => setTool(b.dataset.tool);
});

// CRIAR OBJETOS

function addObject(type) {
  if (!workspace()) return;
  remember();

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

    workspace().connections = workspace().connections.filter(
      c => !ids.has(c.from) && !ids.has(c.to)
    );
  }

  selected = null;
  selectedIds.clear();
  save();
  renderObjects();
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

function updateSelectionBox() {
  const box = $("selectionBox");
  if (!box) return;

  const b = groupBounds();

  box.classList.toggle(
    "hidden",
    !b ||
    selectedIds.size < 2 ||
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
    items: workspace().objects
      .filter(o => selectedIds.has(o.id))
      .map(o => ({
        id: o.id,
        x: o.x,
        y: o.y
      }))
  };
}

function moveGroup(e) {
  if (gesture?.kind !== "group-move") return;

  const p = point(e);
  const dx = p.x - gesture.start.x;
  const dy = p.y - gesture.start.y;

  for (const start of gesture.items) {
    const o = workspace().objects.find(
      x => x.id === start.id
    );

    if (o) {
      o.x = start.x + dx;
      o.y = start.y + dy;
    }
  }

  syncObjectPositions();
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



 // DESENHO LIVRE E QUADRADINHOS

let marquee = null;

function redraw() {
  ctx.clearRect(0, 0, W, H);

  const w = workspace();
  if (!w) return;

  // Quadradinhos pintados
  for (const cell of w.cells) {
    ctx.fillStyle = validColor(cell.color);
    ctx.fillRect(
      cell.x * CELL,
      cell.y * CELL,
      CELL,
      CELL
    );
  }

  // Desenhos livres
  const strokes = [
    ...w.strokes,
    ...(stroke ? [stroke] : [])
  ];

  for (const s of strokes) {
    if (!s.points?.length) continue;

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
    w.cells.push({ x, y, color });
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
  if (
    !workspace() ||
    e.button !== 0 ||
    !["pen", "eraser", "grid"].includes(tool)
  ) return;

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

canvas.onpointerup = finishDrawing;
canvas.onpointercancel = finishDrawing;

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

    selected = selectedIds.size === 1
      ? [...selectedIds][0]
      : null;

    marquee = null;

    $("marqueeBox").classList.add("hidden");

    gesture = null;
    renderObjects();
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

function renderSelectionOnly() {
  for (const el of layer.children) {
    el.classList.toggle(
      "selected",
      selectedIds.has(el.dataset.id)
    );
  }

  updateSelectionBox();
  renderConnections();
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

// EXPORTAR BACKUP

$("exportBtn").onclick = () => {
  const blob = new Blob(
    [JSON.stringify(data, null, 2)],
    { type: "application/json" }
  );

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");

  a.href = url;
  a.download = "amophor-backup-v6-2.json";
  a.click();

  setTimeout(
    () => URL.revokeObjectURL(url),
    1000
  );
};

// IMPORTAR BACKUP

$("importBtn").onclick = () =>
  $("backupInput").click();

$("backupInput").onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const imported = JSON.parse(
      await file.text()
    );

    if (!Array.isArray(imported.projects)) {
      throw new Error("Backup inválido");
    }

    if (!confirm(
      "Substituir TODOS os projetos atuais pelo backup?"
    )) return;

    const old = data;
    data = imported;

    migrateData();

    try {
      saveNow();
      home();
    } catch (error) {
      data = old;
      throw error;
    }
  } catch (error) {
    console.error(error);
    alert("Não foi possível importar o backup.");
  } finally {
    e.target.value = "";
  }
};

// INICIALIZAÇÃO

setTheme(
  localStorage.getItem("amophor_theme") || "dark"
);

setTool("select");
home();
setupGroupHandle();
