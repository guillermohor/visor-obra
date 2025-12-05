import { IfcViewerAPI } from 'web-ifc-viewer';
import { Color, MeshLambertMaterial, Sphere } from 'three';
import wasmAssetUrl from 'url:./wasm/web-ifc.wasm';

const viewerContainer = document.getElementById('viewer-container');
const openButton = document.getElementById('btn-abrir');
const downloadButton = document.getElementById('btn-descargar');
const logButton = document.getElementById('btn-log');
const fileInput = document.getElementById('file-input');
const logPanel = document.getElementById('log-panel');
const logSearchInput = document.createElement('input');
const logHeader = document.createElement('div');

if (logPanel) {
    logHeader.className = 'log-panel-header';
    const title = document.createElement('strong');
    title.textContent = 'Historial de eventos';
    logSearchInput.type = 'search';
    logSearchInput.placeholder = 'Filtrar...';
    logSearchInput.className = 'log-panel-search';
    const headerContent = document.createElement('div');
    headerContent.className = 'log-panel-header-content';
    headerContent.appendChild(title);
    logHeader.appendChild(headerContent);
    logHeader.appendChild(logSearchInput);
    logPanel.prepend(logHeader);
}

function hasModelGeometry(modelID) {
    const modelState = viewer?.IFC?.loader?.ifcManager?.state;
    const models = modelState?.models || [];
    const model = models.find((item) => item.modelID === modelID);
    return Boolean(model?.mesh?.geometry || model?.geometry);
}

function triggerFileDialog() {
    if (!fileInput || fileInput.disabled) {
        addLog('Espera a que termine la carga actual antes de abrir otro IFC.', 'error');
        return;
    }
    try {
        if (typeof fileInput.showPicker === 'function') {
            fileInput.showPicker();
            return;
        }
    } catch (error) {
        console.warn('showPicker no disponible, usando click()', error);
    }
    try {
        fileInput.click();
    } catch (error) {
        addLog('No se pudo abrir el explorador de archivos. Prueba a tocar el campo directamente.', 'error', error);
    }
}
const badge = document.getElementById('badge-registros');
const tagline = document.getElementById('tagline');
const selectedGuidField = document.getElementById('selected-guid');
const dateInput = document.getElementById('input-fecha');
const statusInput = document.getElementById('input-construido');
const registerButton = document.getElementById('btn-registrar');
const commentInput = document.getElementById('input-comentario');
const treeContainer = document.getElementById('tree-container');
const treeSearchInput = document.getElementById('tree-search');

const MAX_LOGS = 8;
const MAX_PERSISTED_LOGS = 200;
const logDOMQueue = [];
const filteredLogDOM = new Set();
const logHistory = [];
const LOG_STORAGE_KEY = 'visor-ifc-log-history';
const AUTO_LOG_DIR = 'visor-ifc-logs';
const AUTO_LOG_FILENAME = 'visor-ifc-log.txt';
let logFileHandlePromise = null;
let logFileSize = 0;
let restoringLogs = false;
let localStorageSupported;
const records = [];
const state = {
    modelLoaded: false,
    activeModelId: null,
    lastTouchTime: 0,
    pendingSelection: null,
    skipNextTouchSelect: false,
    spatialTree: null,
    loadingModel: false
};

restoreLogHistory();

const viewer = new IfcViewerAPI({
    container: viewerContainer,
    backgroundColor: new Color('#050a0f')
});
viewer.axes.setAxes();
viewer.grid.setGrid();
let wasmInitPromise = null;
async function ensureWasmInitialized() {
    if (!wasmInitPromise) {
        const ifcApi = viewer.IFC.loader.ifcManager.ifcAPI;
        wasmInitPromise = ifcApi.Init((path, prefix) => {
            if (path.endsWith('.wasm')) {
                return wasmAssetUrl;
            }
            return prefix + path;
        });
    }
    return wasmInitPromise;
}

async function focusCurrentSelection() {
    if (!state.pendingSelection) {
        await selectElementFromScene({ focusOnSelect: true, logSelection: false });
        return;
    }
    const { modelID, expressID } = state.pendingSelection;
    try {
        await flashElement(modelID, expressID, { focus: true });
    } catch (error) {
        addLog('No se pudo acercar al elemento seleccionado.', 'error', error);
        console.error(error);
    }
}

async function buildSpatialTree(modelID) {
    if (!treeContainer) {
        return;
    }
    treeContainer.textContent = 'Generando árbol IFC…';
    try {
        const structure = await viewer.IFC.getSpatialStructure(modelID, true);
        attachModelId(structure, modelID);
        state.spatialTree = structure;
        renderSpatialTree();
        addLog('Árbol IFC generado.', 'success');
    } catch (error) {
        treeContainer.textContent = 'No se pudo generar el árbol.';
        addLog('No se pudo generar el árbol IFC.', 'error', error);
        console.error(error);
    }
}

function attachModelId(node, modelID) {
    if (!node) {
        return;
    }
    node.modelID = modelID;
    node.children?.forEach((child) => attachModelId(child, modelID));
}

function renderSpatialTree() {
    if (!treeContainer) {
        return;
    }
    if (!state.spatialTree) {
        treeContainer.textContent = 'Carga un IFC para ver la estructura.';
        return;
    }
    treeContainer.innerHTML = '';
    const searchTerm = (treeSearchInput?.value || '').trim().toLowerCase();
    const fragment = document.createDocumentFragment();
    (state.spatialTree.children || []).forEach((child) => {
        const nodeElement = createTreeNodeElement(child, searchTerm);
        if (nodeElement) {
            fragment.appendChild(nodeElement);
        }
    });
    if (!fragment.childNodes.length) {
        treeContainer.textContent = searchTerm ? 'Sin resultados para tu búsqueda.' : 'No se encontraron elementos.';
        return;
    }
    treeContainer.appendChild(fragment);
}

function createTreeNodeElement(node, searchTerm) {
    if (!node) {
        return null;
    }
    const label = formatNodeLabel(node);
    const labelMatches = !searchTerm || label.toLowerCase().includes(searchTerm);
    const childrenElements = (node.children || [])
        .map((child) => createTreeNodeElement(child, searchTerm))
        .filter(Boolean);
    if (!labelMatches && !childrenElements.length) {
        return null;
    }
    const container = document.createElement('div');
    container.className = 'tree-node';
    const button = document.createElement('button');
    button.className = 'tree-node-btn';
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
        selectElement(node.modelID, node.expressID, { focusOnSelect: true }).catch((error) => {
            console.error('No se pudo seleccionar desde el árbol.', error);
        });
    });
    container.appendChild(button);
    if (childrenElements.length) {
        const childrenWrapper = document.createElement('div');
        childrenWrapper.className = 'tree-children';
        childrenElements.forEach((element) => childrenWrapper.appendChild(element));
        container.appendChild(childrenWrapper);
    }
    return container;
}

function formatNodeLabel(node) {
    const name = node?.name || 'Sin nombre';
    const type = node?.type ? ` (${node.type})` : '';
    return `${name}${type}`;
}

function clearTreePanel(message = 'Carga un IFC para ver la estructura.') {
    if (treeContainer) {
        treeContainer.textContent = message;
    }
    state.spatialTree = null;
}

function resetTreeSearch() {
    if (treeSearchInput) {
        treeSearchInput.value = '';
    }
}

async function unloadCurrentModel() {
    if (state.activeModelId === null) {
        return;
    }
    try {
        viewer.IFC.removeIfcModel(state.activeModelId);
        const api = viewer.IFC.loader.ifcManager.ifcAPI;
        if (api?.CloseModel) {
            await api.CloseModel(state.activeModelId);
        }
    } catch (error) {
        addLog('No se pudo descargar el modelo anterior completamente.', 'error', error);
        console.error(error);
    } finally {
        state.activeModelId = null;
        state.modelLoaded = false;
    }
}

function setAppLoading(isLoading, message) {
    openButton.disabled = isLoading;
    fileInput.disabled = isLoading;
    if (isLoading) {
        registerButton.disabled = true;
        clearPendingSelection();
        if (tagline) {
            tagline.hidden = false;
            tagline.textContent = message || 'Cargando IFC…';
        }
        clearTreePanel('Preparando para el nuevo modelo…');
    }
    if (!isLoading && !state.modelLoaded && tagline) {
        tagline.hidden = false;
        tagline.textContent = '🛠️ Listo para registrar elementos';
    }
}

const builtMaterial = new MeshLambertMaterial({
    color: new Color('#0ee6a8'),
    transparent: true,
    opacity: 0.7,
    depthTest: false,
    depthWrite: false
});
builtMaterial.clippingPlanes = viewer.context.getClippingPlanes();

downloadButton.disabled = true;
resetFormControls();
clearTreePanel();

openButton.addEventListener('click', () => {
    triggerFileDialog();
});
fileInput.addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (!file) {
        return;
    }
    const loaded = await loadIfc(file);
    if (loaded) {
        fileInput.value = '';
    }
});

downloadButton.addEventListener('click', () => {
    if (!records.length) {
        return;
    }
    const csvContent = buildCsv(records);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `registros-ifc-${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    addLog('CSV exportado correctamente.', 'success');
});

logButton.addEventListener('click', () => {
    if (!logHistory.length) {
        addLog('No hay eventos para exportar.', 'error');
        return;
    }
    const logText = logHistory.join('\n');
    const blob = new Blob([logText], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `visor-ifc-log-${Date.now()}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
});

viewerContainer.addEventListener('pointerup', handlePointerSelection);
viewerContainer.addEventListener('pointerdown', handleTouchPointerDown);
viewerContainer.addEventListener('dblclick', handleCanvasDoubleClick);

treeSearchInput?.addEventListener('input', () => renderSpatialTree());
logSearchInput?.addEventListener('input', () => refreshLogPanel());

registerButton?.addEventListener('click', () => {
    if (!state.pendingSelection) {
        addLog('Selecciona un elemento antes de registrar.', 'error');
        return;
    }
    const dateValue = getDateInputValue();
    if (!dateValue) {
        addLog('Elige una fecha válida para registrar.', 'error');
        return;
    }
    const statusValue = getStatusValue();
    const commentValue = getCommentValue();
    const { guid } = state.pendingSelection;
    pushRecord(guid, dateValue, statusValue, commentValue);
    addLog(`Registro guardado para ${guid}.`, 'success');
    clearPendingSelection();
    clearCommentInput();
});

async function loadIfc(source) {
    if (state.loadingModel) {
        addLog('Ya hay un IFC cargándose. Espera a que termine.', 'error');
        return false;
    }
    try {
        const sourceName = getSourceName(source);
        addLog(`Cargando ${sourceName}…`);
        setAppLoading(true, `Descargando ${sourceName}…`);
        state.loadingModel = true;
        await unloadCurrentModel();
        downloadButton.disabled = true;
        resetRecords();
        await ensureWasmInitialized();
        const model = typeof source === 'string'
            ? await viewer.IFC.loadIfcUrl(source, true)
            : await viewer.IFC.loadIfc(source, true);
        state.modelLoaded = true;
        state.activeModelId = model.modelID;
        addLog(`Modelo listo: ${sourceName}`, 'success');
        await buildSpatialTree(model.modelID);
        return true;
    } catch (error) {
        addLog('No se pudo cargar el IFC. Revisa el archivo.', 'error', error);
        console.error(error);
        return false;
    } finally {
        state.loadingModel = false;
        setAppLoading(false);
    }
}

function resetRecords() {
    records.length = 0;
    updateBadge();
    if (tagline) {
        tagline.hidden = false;
        tagline.textContent = '🛠️ Listo para registrar elementos';
    }
    clearPendingSelection();
    resetFormControls();
    resetTreeSearch();
    clearTreePanel();
    downloadButton.disabled = true;
}

async function handlePointerSelection(event) {
    if (!state.modelLoaded) {
        return;
    }
    if (event.pointerType === 'touch' && state.skipNextTouchSelect) {
        state.skipNextTouchSelect = false;
        return;
    }
    if (event.detail > 1) {
        return;
    }
    event.preventDefault();
    await selectElementFromScene();
}

function handleTouchPointerDown(event) {
    if (event.pointerType !== 'touch') {
        return;
    }
    const now = Date.now();
    if (now - state.lastTouchTime < 350) {
        state.lastTouchTime = 0;
        state.skipNextTouchSelect = true;
        handleCanvasDoubleClick(event);
        return;
    }
    state.lastTouchTime = now;
}

async function handleCanvasDoubleClick(event) {
    event.preventDefault();
    await focusCurrentSelection();
}

async function selectElementFromScene(options) {
    try {
        const selection = await viewer.IFC.selector.pickIfcItem();
        if (!selection) {
            addLog('No se detectó ningún elemento en la selección.', 'error');
            return;
        }
        if (!hasModelGeometry(selection.modelID)) {
            addLog('La geometría aún se está generando; espera unos segundos.', 'error');
            return;
        }
        await selectElement(selection.modelID, selection.id, options);
    } catch (error) {
        addLog('Error al seleccionar el elemento.', 'error', error);
        console.error(error);
    }
}

async function selectElement(modelID, expressID, options = {}) {
    if (modelID == null || expressID == null) {
        return;
    }
    const { focusOnSelect = false, logSelection = true } = options;
    try {
        await flashElement(modelID, expressID, { focus: focusOnSelect });
        const guid = await fetchGuid(modelID, expressID);
        if (!guid) {
            addLog('El elemento seleccionado no tiene GUID.', 'error');
            return;
        }
        setPendingSelection({ modelID, expressID, guid });
        if (logSelection) {
            addLog(`Elemento ${guid} listo para registrar.`, 'success');
        }
    } catch (error) {
        addLog('No se pudo manejar la selección del elemento.', 'error', error);
        console.error(error);
    }
}

async function flashElement(modelID, expressID, options = {}) {
    const { focus = false } = options;
    if (!hasModelGeometry(modelID)) {
        addLog('El modelo todavía no terminó de preparar la geometría.', 'error');
        return null;
    }
    const subset = await viewer.IFC.loader.ifcManager.createSubset({
        scene: viewer.context.getScene(),
        modelID,
        ids: [expressID],
        removePrevious: false,
        material: builtMaterial
    });
    if (!subset) {
        return;
    }
    if (focus) {
        focusOnSubset(subset);
    }
    setTimeout(() => {
        viewer.IFC.loader.ifcManager.removeSubset(modelID, builtMaterial);
    }, 1600);
}

async function fetchGuid(modelID, expressID) {
    const props = await viewer.IFC.loader.ifcManager.getItemProperties(modelID, expressID, true);
    if (!props) {
        return null;
    }
    const guid = props.GlobalId?.value || props.GlobalId;
    return typeof guid === 'string' ? guid : null;
}

function pushRecord(guid, date, status, comment) {
    const row = {
        guid,
        date,
        status,
        comment
    };
    records.push(row);
    updateBadge();
    downloadButton.disabled = false;
}

function updateBadge() {
    badge.textContent = `${records.length} registro${records.length === 1 ? '' : 's'}`;
}

function buildCsv(rows) {
    const header = 'GUID,FECHA,ESTADO,COMENTARIO';
    const data = rows.map((row) => [row.guid, row.date, row.status, row.comment]
        .map(escapeCsv)
        .join(','));
    return [header, ...data].join('\n');
}

function addLog(message, type = 'info', detail) {
    const detailText = detail ? ((detail && detail.stack) ? detail.stack : JSON.stringify(detail)) : '';
    const entry = {
        message,
        type,
        timestamp: new Date().toISOString(),
        detailText
    };
    logHistory.push(formatLogLine(entry));
    renderLogEntry(entry, detail);
    if (!restoringLogs) {
        persistLogEntry(entry);
        void appendLogToFile(logHistory[logHistory.length - 1]);
    }
}

window.addEventListener('load', () => {
    registerServiceWorker();
});

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
        return;
    }
    navigator.serviceWorker
        .register(new URL('./sw.js', import.meta.url))
        .then(() => addLog('PWA lista para modo offline.', 'success'))
        .catch((error) => {
            addLog('No se pudo registrar el Service Worker.', 'error', error);
            console.error(error);
        });
}

function getSourceName(source) {
    if (typeof source === 'string') {
        try {
            const url = new URL(source, window.location.href);
            const parts = url.pathname.split('/').filter(Boolean);
            const lastSegment = parts[parts.length - 1];
            return decodeURIComponent(lastSegment || source);
        } catch (_) {
            return source;
        }
    }
    return source?.name || 'archivo IFC';
}

function setPendingSelection(selection) {
    state.pendingSelection = selection;
    if (selectedGuidField) {
        selectedGuidField.textContent = selection.guid;
    }
    registerButton.disabled = false;
    if (!dateInput.value) {
        dateInput.value = getTodayDateValue();
    }
    commentInput?.focus({ preventScroll: true });
}

function clearPendingSelection() {
    state.pendingSelection = null;
    if (selectedGuidField) {
        selectedGuidField.textContent = 'Toca un elemento para registrarlo.';
    }
    if (registerButton) {
        registerButton.disabled = true;
    }
}

function resetFormControls() {
    if (dateInput) {
        dateInput.value = getTodayDateValue();
    }
    if (statusInput) {
        statusInput.checked = true;
    }
    clearCommentInput();
}

function getTodayDateValue() {
    return new Date().toISOString().split('T')[0];
}

function getDateInputValue() {
    return dateInput?.value || '';
}

function getStatusValue() {
    return statusInput?.checked ? 'CONSTRUIDO' : 'PENDIENTE';
}

function getCommentValue() {
    return commentInput?.value?.trim() || '';
}

function clearCommentInput() {
    if (commentInput) {
        commentInput.value = '';
    }
}

function escapeCsv(value) {
    const stringValue = value ?? '';
    if (stringValue instanceof Date) {
        return stringValue.toISOString();
    }
    const text = String(stringValue);
    if (/[",\n]/.test(text)) {
        return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
}

function focusOnSubset(subset) {
    const cameraControls = viewer.context?.ifcCamera?.cameraControls;
    if (!subset || !subset.geometry || !cameraControls || typeof cameraControls.fitToSphere !== 'function') {
        return;
    }
    const geometry = subset.geometry;
    if (!geometry.boundingSphere) {
        geometry.computeBoundingSphere();
    }
    const sphere = geometry.boundingSphere;
    if (!sphere) {
        return;
    }
    const worldSphere = sphere instanceof Sphere ? sphere.clone() : new Sphere(sphere.center.clone(), sphere.radius);
    worldSphere.applyMatrix4(subset.matrixWorld);
    cameraControls.fitToSphere(worldSphere, true).catch((error) => {
        console.warn('No se pudo ajustar la cámara al elemento seleccionado.', error);
    });
}

function renderLogEntry(entry, rawDetail) {
    if (!logPanel) {
        return;
    }
    const timestampText = formatLogDisplayTime(entry.timestamp);
    const domEntry = document.createElement('div');
    domEntry.className = `log-entry${entry.type !== 'info' ? ` ${entry.type}` : ''}`;
    domEntry.dataset.message = entry.message.toLowerCase();
    domEntry.dataset.time = timestampText;
    const strong = document.createElement('strong');
    strong.textContent = entry.message;
    const small = document.createElement('small');
    small.textContent = timestampText;
    domEntry.appendChild(strong);
    domEntry.appendChild(small);
    logPanel.appendChild(domEntry);
    logDOMQueue.push(domEntry);
    if (logDOMQueue.length > MAX_LOGS) {
        const oldest = logDOMQueue.shift();
        filteredLogDOM.delete(oldest);
        oldest?.remove();
    }
    refreshLogPanel();
    if (entry.type === 'error') {
        console.error(`[${timestampText}] ${entry.message}`, rawDetail || entry.detailText);
    } else if (entry.type === 'success') {
        console.info(`[${timestampText}] ${entry.message}`);
    } else {
        console.log(`[${timestampText}] ${entry.message}`);
    }
}

function formatLogDisplayTime(timestamp) {
    try {
        return new Date(timestamp).toLocaleTimeString('es-ES', { hour12: false });
    } catch (_) {
        return new Date().toLocaleTimeString('es-ES', { hour12: false });
    }
}

function formatLogLine(entry) {
    const timeText = formatLogDisplayTime(entry.timestamp);
    const suffix = entry.detailText ? `\n${entry.detailText}` : '';
    const typeLabel = (entry.type || 'info').toUpperCase();
    return `[${timeText}] [${typeLabel}] ${entry.message}${suffix}`;
}

function refreshLogPanel() {
    if (!logPanel) {
        return;
    }
    const filterValue = (logSearchInput?.value || '').trim().toLowerCase();
    const shouldShowTagline = !logHistory.length;
    if (tagline) {
        tagline.hidden = !shouldShowTagline;
    }
    logDOMQueue.forEach((entry) => {
        if (!filterValue) {
            entry.hidden = false;
            return;
        }
        const matches = entry.dataset.message?.includes(filterValue)
            || entry.dataset.time?.includes(filterValue);
        entry.hidden = !matches;
        if (!matches) {
            filteredLogDOM.add(entry);
        } else {
            filteredLogDOM.delete(entry);
        }
    });
}

function persistLogEntry(entry) {
    if (!hasLocalStorageSupport()) {
        return;
    }
    try {
        const stored = JSON.parse(localStorage.getItem(LOG_STORAGE_KEY) || '[]');
        if (Array.isArray(stored)) {
            stored.push(entry);
            const trimmed = stored.slice(-MAX_PERSISTED_LOGS);
            localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(trimmed));
        }
    } catch (error) {
        console.warn('No se pudo guardar el log en almacenamiento local.', error);
    }
}

function restoreLogHistory() {
    if (!hasLocalStorageSupport()) {
        return;
    }
    try {
        const stored = JSON.parse(localStorage.getItem(LOG_STORAGE_KEY) || '[]');
        if (!Array.isArray(stored) || !stored.length) {
            return;
        }
        restoringLogs = true;
        stored.forEach((rawEntry) => {
            const entry = normalizeStoredEntry(rawEntry);
            renderLogEntry(entry);
            logHistory.push(formatLogLine(entry));
        });
    } catch (error) {
        console.warn('No se pudieron restaurar los logs previos.', error);
    } finally {
        restoringLogs = false;
    }
}

function normalizeStoredEntry(entry) {
    if (!entry || typeof entry !== 'object') {
        return {
            message: typeof entry === 'string' ? entry : 'Evento',
            type: 'info',
            timestamp: new Date().toISOString(),
            detailText: ''
        };
    }
    return {
        message: entry.message || 'Evento',
        type: entry.type || 'info',
        timestamp: entry.timestamp || new Date().toISOString(),
        detailText: entry.detailText || ''
    };
}

function hasLocalStorageSupport() {
    if (localStorageSupported !== undefined) {
        return localStorageSupported;
    }
    try {
        if (typeof window === 'undefined' || !window.localStorage) {
            localStorageSupported = false;
            return localStorageSupported;
        }
        const testKey = '__visor_ifc_log_test__';
        window.localStorage.setItem(testKey, '1');
        window.localStorage.removeItem(testKey);
        localStorageSupported = true;
    } catch (_) {
        localStorageSupported = false;
    }
    return localStorageSupported;
}

async function appendLogToFile(line) {
    const handle = await getLogFileHandle();
    if (!handle?.createWritable) {
        return;
    }
    try {
        const writable = await handle.createWritable({ keepExistingData: true });
        await writable.seek(logFileSize);
        const data = `${line}\n`;
        await writable.write(data);
        await writable.close();
        logFileSize += data.length;
    } catch (error) {
        console.warn('No se pudo escribir el log automático.', error);
    }
}

async function getLogFileHandle() {
    if (logFileHandlePromise) {
        return logFileHandlePromise;
    }
    if (!('storage' in navigator) || typeof navigator.storage.getDirectory !== 'function') {
        logFileHandlePromise = Promise.resolve(null);
        return logFileHandlePromise;
    }
    logFileHandlePromise = navigator.storage.getDirectory()
        .then(async (root) => {
            const dirHandle = await root.getDirectoryHandle(AUTO_LOG_DIR, { create: true });
            const fileHandle = await dirHandle.getFileHandle(AUTO_LOG_FILENAME, { create: true });
            try {
                const file = await fileHandle.getFile();
                logFileSize = file.size;
            } catch (_) {
                logFileSize = 0;
            }
            return fileHandle;
        })
        .catch((error) => {
            console.warn('No se pudo inicializar el almacenamiento privado de logs.', error);
            return null;
        });
    return logFileHandlePromise;
}
