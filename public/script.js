// Global State Variables
const _now = new Date();
const _curY = _now.getFullYear();
const _curM = String(_now.getMonth() + 1).padStart(2, '0');
const _curD = String(_now.getDate()).padStart(2, '0');
let currentMonth = `${_curY}-${_curM}`; // Format YYYY-MM — defaults to current month

// Calculate current week start (Sunday)
const _dayOfWeek = _now.getDay(); // 0=Sun
const _sundayDate = new Date(_now);
_sundayDate.setDate(_now.getDate() - _dayOfWeek);
let currentWeekStart = `${_sundayDate.getFullYear()}-${String(_sundayDate.getMonth() + 1).padStart(2, '0')}-${String(_sundayDate.getDate()).padStart(2, '0')}`; // Format YYYY-MM-DD

// Task Tracker month state
let currentTaskMonth = `${_curY}-${_curM}`;

// ==========================================
// DATABASE ENGINE — SUPABASE-FIRST ARCHITECTURE
// When Supabase is connected: ALL reads/writes go directly to Supabase (primary DB).
// When offline/not configured: falls back to localStorage (offline mode).
// This enables true cross-device sync across multiple devices.
// ==========================================
let supabaseClient = null;

// localStorage cache helpers (used as offline fallback and for seeded data)
const LocalDB = {
    get(coll) {
        try {
            const data = localStorage.getItem(`db_${coll}`);
            if (!data) return [];
            const parsed = JSON.parse(data);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.error(`Error parsing LocalDB collection ${coll}:`, e);
            return [];
        }
    },
    set(coll, data) {
        localStorage.setItem(`db_${coll}`, JSON.stringify(data));
    },
    // Low-level local find (used by SupabaseDB offline fallback)
    _find(coll, query = {}) {
        return this.get(coll).filter(doc => {
            for (const key in query) {
                if (doc[key] !== query[key]) return false;
            }
            return true;
        });
    },
    _findOne(coll, query = {}) {
        return this.get(coll).find(doc => {
            for (const key in query) {
                if (doc[key] !== query[key]) return false;
            }
            return true;
        }) || null;
    },
    _insert(coll, doc) {
        const data = this.get(coll);
        const newDoc = {
            _id: Math.random().toString(36).substr(2, 9) + Date.now().toString(36),
            ...doc,
            created_at: new Date().toISOString()
        };
        data.push(newDoc);
        this.set(coll, data);
        return newDoc;
    },
    _update(coll, query, $set) {
        const data = this.get(coll);
        let changed = 0;
        data.forEach((doc, idx) => {
            const match = Object.keys(query).every(k => doc[k] === query[k]);
            if (match) { data[idx] = { ...doc, ...$set }; changed++; }
        });
        if (changed) this.set(coll, data);
        return changed;
    },
    _delete(coll, query) {
        const data = this.get(coll);
        const remaining = data.filter(doc => !Object.keys(query).every(k => doc[k] === query[k]));
        this.set(coll, remaining);
        return data.length - remaining.length;
    }
};

// SupabaseDB — the unified data access layer
// When supabaseClient is set, ALL operations go directly to Supabase.
// Falls back to LocalDB (localStorage) when not connected.
// Track if we've already warned about missing tables
let _supabaseTablesWarned = false;

function _warnMissingTables(error) {
    if (_supabaseTablesWarned) return;
    
    let message = '⚠️ Erro no Supabase. Usando localStorage temporariamente.';
    let isMissingTable = false;
    
    if (error) {
        const code = String(error.code || '');
        const msg = String(error.message || '');
        const status = Number(error.status || 0);
        
        if (code === '42P01' || (msg.includes('relation') && msg.includes('does not exist'))) {
            isMissingTable = true;
            _supabaseTablesWarned = true; // Only block warning triggers on missing tables to avoid spamming connection errors
            message = '⚠️ Tabelas do Supabase não encontradas. Execute o arquivo <strong>supabase_setup.sql</strong> no SQL Editor do Supabase.';
        } else if (status === 401 || code === 'PGRST301' || msg.includes('JWT') || msg.includes('Invalid API key') || msg.includes('apiKey')) {
            message = '⚠️ Erro de Autenticação no Supabase. Verifique se sua URL e Chave Anon estão corretas nas configurações.';
        } else if (status === 0 || msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
            message = '⚠️ Não foi possível conectar ao Supabase. Verifique sua conexão de rede ou a URL configurada.';
        } else {
            message = `⚠️ Erro no Supabase (${code || status}): ${msg}. Usando localStorage.`;
        }
    }
    
    // Show a visible banner in the UI
    const existing = document.getElementById('supabase-missing-banner');
    if (existing) {
        existing.innerHTML = `${message} <button onclick="this.parentElement.remove()" style="margin-left:12px;background:rgba(255,255,255,0.2);border:none;color:#fff;padding:4px 10px;border-radius:4px;cursor:pointer;">✕ Fechar</button>`;
    } else {
        const banner = document.createElement('div');
        banner.id = 'supabase-missing-banner';
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#dc2626;color:#fff;text-align:center;padding:10px 16px;font-size:13px;font-weight:600;';
        banner.innerHTML = `${message} <button onclick="this.parentElement.remove()" style="margin-left:12px;background:rgba(255,255,255,0.2);border:none;color:#fff;padding:4px 10px;border-radius:4px;cursor:pointer;">✕ Fechar</button>`;
        document.body.prepend(banner);
    }
}

const dbSchemaStyle = {}; // Stores detected schema style per collection ({ pk: '_id'|'id', case: 'camelcase'|'lowercase' })
const lastQueryTime = {}; // Throttles background queries to prevent infinite loop recursion (SWR throttle)

function detectSchemaStyle(coll, sampleDoc) {
    if (!sampleDoc) return;
    dbSchemaStyle[coll] = dbSchemaStyle[coll] || { pk: '_id', case: 'camelcase' };
    const keys = Object.keys(sampleDoc);
    
    if (keys.includes('habitid') || keys.includes('weekstartdate') || keys.includes('dayofweek') || keys.includes('weekofmonth') || keys.includes('startdate')) {
        dbSchemaStyle[coll].case = 'lowercase';
    } else {
        dbSchemaStyle[coll].case = 'camelcase';
    }
    
    if (keys.includes('id') && !keys.includes('_id')) {
        dbSchemaStyle[coll].pk = 'id';
    } else {
        dbSchemaStyle[coll].pk = '_id';
    }
    console.log(`[DB] Schema style detected for ${coll}:`, dbSchemaStyle[coll]);
}

function normalizeFromSupabase(coll, doc) {
    if (!doc) return doc;
    const copy = { ...doc };
    
    // Map primary key from Supabase (id -> _id)
    if (dbSchemaStyle[coll]?.pk === 'id' && 'id' in copy) {
        copy._id = copy.id;
        delete copy.id;
    }
    
    // Map lowercase to camelCase (what local database uses)
    if ('habitid' in copy) { copy.habitId = copy.habitid; delete copy.habitid; }
    if ('weekstartdate' in copy) { copy.weekStartDate = copy.weekstartdate; delete copy.weekstartdate; }
    if ('dayofweek' in copy) { copy.dayOfWeek = copy.dayofweek; delete copy.dayofweek; }
    if ('weekofmonth' in copy) { copy.weekOfMonth = copy.weekofmonth; delete copy.weekofmonth; }
    if ('startdate' in copy) { copy.startDate = copy.startdate; delete copy.startdate; }
    if ('enddate' in copy) { copy.endDate = copy.endDate; delete copy.endDate; }
    if ('durationms' in copy) { copy.durationMs = copy.durationms; delete copy.durationms; }
    
    // Map created_at to createdAt if createdAt is missing
    if ('created_at' in copy && !('createdAt' in copy)) {
        copy.createdAt = copy.created_at;
    }
    return copy;
}

function normalizeToSupabase(coll, doc) {
    if (!doc) return doc;
    const copy = { ...doc };
    
    // Map createdAt to created_at (what Supabase always uses for timestamp)
    if ('createdAt' in copy) {
        if (!copy.created_at) copy.created_at = copy.createdAt;
        delete copy.createdAt;
    }
    
    // Map primary key to Supabase (_id -> id)
    if (dbSchemaStyle[coll]?.pk === 'id' && '_id' in copy) {
        copy.id = copy._id;
        delete copy._id;
    }
    
    // Map camelCase to lowercase if the database is using lowercase column names
    if (dbSchemaStyle[coll]?.case === 'lowercase') {
        if ('habitId' in copy) { copy.habitid = copy.habitId; delete copy.habitId; }
        if ('weekStartDate' in copy) { copy.weekstartdate = copy.weekStartDate; delete copy.weekStartDate; }
        if ('dayOfWeek' in copy) { copy.dayofweek = copy.dayOfWeek; delete copy.dayofweek; }
        if ('weekOfMonth' in copy) { copy.weekofmonth = copy.weekOfMonth; delete copy.weekofmonth; }
        if ('startDate' in copy) { copy.startdate = copy.startDate; delete copy.startdate; }
        if ('endDate' in copy) { copy.enddate = copy.endDate; delete copy.enddate; }
        if ('durationMs' in copy) { copy.durationms = copy.durationMs; delete copy.durationMs; }
    } else {
        // Ensure keys match camelCase (for quoted columns in postgres)
        if ('habitid' in copy) { copy.habitId = copy.habitid; delete copy.habitid; }
        if ('weekstartdate' in copy) { copy.weekStartDate = copy.weekstartdate; delete copy.weekstartdate; }
        if ('dayofweek' in copy) { copy.dayOfWeek = copy.dayofweek; delete copy.dayofweek; }
        if ('weekofmonth' in copy) { copy.weekOfMonth = copy.weekofmonth; delete copy.weekofmonth; }
        if ('startdate' in copy) { copy.startDate = copy.startdate; delete copy.startdate; }
        if ('enddate' in copy) { copy.endDate = copy.enddate; delete copy.enddate; }
        if ('durationms' in copy) { copy.durationMs = copy.durationms; delete copy.durationms; }
    }
    return copy;
}

function refreshActivePageForCollection(coll) {
    const activePage = document.querySelector('.dashboard-page.active');
    if (!activePage) return;
    const id = activePage.id;
    
    if (id === 'page-habit-tracker' && ['habits', 'habit_entries', 'mental_state'].includes(coll)) {
        loadHabitTrackerData();
    } else if (id === 'page-task-tracker' && ['tasks', 'mindset_tracker', 'mental_state'].includes(coll)) {
        loadTaskTrackerData();
    } else if (id === 'page-monthly-tracker' && coll === 'monthly_tasks') {
        loadMonthlyTrackerData();
    } else if (id === 'page-daily-notes' && coll === 'daily_notes') {
        loadDailyNotesData();
    } else if (id === 'page-relapse-tracker' && ['last_fall', 'relapse_history'].includes(coll)) {
        loadRelapseData();
    }
}

const SupabaseDB = {
    async find(coll, query = {}) {
        const localData = LocalDB._find(coll, query);
        if (supabaseClient) {
            const now = Date.now();
            const lastTime = lastQueryTime[coll] || 0;
            if (now - lastTime > 15000) { // 15s throttle to prevent infinite SWR recursion
                lastQueryTime[coll] = now;
                
                let req = supabaseClient.from(coll).select('*');
                const dbQuery = normalizeToSupabase(coll, query);
                for (const [k, v] of Object.entries(dbQuery)) {
                    if (v !== undefined && v !== null) req = req.eq(k, v);
                }
                req.then(({ data, error }) => {
                    if (error) {
                        console.error(`[DB] Background find ${coll}:`, error);
                        _warnMissingTables(error);
                    } else if (data) {
                        const normalized = data.map(item => normalizeFromSupabase(coll, item));
                        if (Object.keys(query).length === 0) {
                            LocalDB.set(coll, normalized);
                        } else {
                            const cached = LocalDB.get(coll);
                            normalized.forEach(item => {
                                const idx = cached.findIndex(x => x._id === item._id);
                                if (idx !== -1) cached[idx] = item;
                                else cached.push(item);
                            });
                            LocalDB.set(coll, cached);
                        }
                        refreshActivePageForCollection(coll);
                    }
                }).catch(err => console.error(`[DB] Background find exception on ${coll}:`, err));
            }
        }
        return localData;
    },
    async findOne(coll, query = {}) {
        const localDoc = LocalDB._findOne(coll, query);
        if (supabaseClient) {
            const now = Date.now();
            const lastTime = lastQueryTime[coll] || 0;
            if (now - lastTime > 15000) { // 15s throttle to prevent infinite SWR recursion
                lastQueryTime[coll] = now;
                
                const dbQuery = normalizeToSupabase(coll, query);
                let req = supabaseClient.from(coll).select('*');
                for (const [k, v] of Object.entries(dbQuery)) {
                    if (v !== undefined && v !== null) req = req.eq(k, v);
                }
                req = req.limit(1);
                const hasFilters = Object.keys(query).length > 0;
                const promise = hasFilters ? req.maybeSingle() : req.then(({ data, error }) => ({ data: (data && data.length > 0) ? data[0] : null, error }));
                Promise.resolve(promise).then(({ data, error }) => {
                    if (error) {
                        console.error(`[DB] Background findOne ${coll}:`, error);
                        _warnMissingTables(error);
                    } else if (data) {
                        const normalized = normalizeFromSupabase(coll, data);
                        const cached = LocalDB.get(coll);
                        const idx = cached.findIndex(x => x._id === normalized._id);
                        if (idx !== -1) {
                            cached[idx] = normalized;
                        } else {
                            cached.push(normalized);
                        }
                        LocalDB.set(coll, cached);
                        refreshActivePageForCollection(coll);
                    }
                }).catch(err => console.error(`[DB] Background findOne exception on ${coll}:`, err));
            }
        }
        return localDoc;
    },
    async insert(coll, doc) {
        const newDoc = {
            _id: doc._id || (Math.random().toString(36).substr(2, 9) + Date.now().toString(36)),
            ...doc,
            created_at: doc.created_at || doc.createdAt || new Date().toISOString()
        };
        delete newDoc.createdAt;
        const localResult = LocalDB._insert(coll, newDoc);
        if (supabaseClient) {
            const dbDoc = normalizeToSupabase(coll, newDoc);
            supabaseClient.from(coll).insert([dbDoc]).select().single()
                .then(({ data, error }) => {
                    if (error) {
                        console.error(`[DB] Async insert ${coll}:`, error);
                        _warnMissingTables(error);
                    } else if (data) {
                        const cached = LocalDB.get(coll);
                        const idx = cached.findIndex(x => x._id === newDoc._id);
                        if (idx !== -1) {
                            cached[idx] = normalizeFromSupabase(coll, data);
                            LocalDB.set(coll, cached);
                        }
                    }
                })
                .catch(err => console.error(`[DB] Async insert exception on ${coll}:`, err));
        }
        return localResult;
    },
    async upsert(coll, doc, conflictKey = '_id') {
        const upsertDoc = {
            _id: doc._id || (Math.random().toString(36).substr(2, 9) + Date.now().toString(36)),
            ...doc
        };
        if ('createdAt' in upsertDoc) {
            if (!upsertDoc.created_at) upsertDoc.created_at = upsertDoc.createdAt;
            delete upsertDoc.createdAt;
        }
        const cached = LocalDB.get(coll);
        const existingIdx = cached.findIndex(x => x[conflictKey] === upsertDoc[conflictKey]);
        if (existingIdx !== -1) {
            cached[existingIdx] = { ...cached[existingIdx], ...upsertDoc };
            LocalDB.set(coll, cached);
        } else {
            LocalDB._insert(coll, upsertDoc);
        }
        if (supabaseClient) {
            const dbDoc = normalizeToSupabase(coll, upsertDoc);
            const dbConflictKey = (dbSchemaStyle[coll] === 'lowercase' && conflictKey === 'habitId') ? 'habitid' : conflictKey;
            supabaseClient.from(coll).upsert([dbDoc], { onConflict: dbConflictKey }).select().single()
                .then(({ data, error }) => {
                    if (error) {
                        console.error(`[DB] Async upsert ${coll}:`, error);
                        _warnMissingTables(error);
                    } else if (data) {
                        const updatedCache = LocalDB.get(coll);
                        const idx = updatedCache.findIndex(x => x._id === data._id);
                        if (idx !== -1) {
                            updatedCache[idx] = normalizeFromSupabase(coll, data);
                            LocalDB.set(coll, updatedCache);
                        }
                    }
                })
                .catch(err => console.error(`[DB] Async upsert exception on ${coll}:`, err));
        }
        return upsertDoc;
    },
    async update(coll, query, $set) {
        const changed = LocalDB._update(coll, query, $set);
        if (supabaseClient) {
            const dbQuery = normalizeToSupabase(coll, query);
            const dbSet = normalizeToSupabase(coll, $set);
            let req = supabaseClient.from(coll).update(dbSet);
            for (const [k, v] of Object.entries(dbQuery)) { req = req.eq(k, v); }
            req.then(({ error }) => {
                if (error) {
                    console.error(`[DB] Async update ${coll}:`, error);
                    _warnMissingTables(error);
                }
            }).catch(err => console.error(`[DB] Async update exception on ${coll}:`, err));
        }
        return changed;
    },
    async delete(coll, query) {
        const deletedCount = LocalDB._delete(coll, query);
        if (supabaseClient) {
            const dbQuery = normalizeToSupabase(coll, query);
            let req = supabaseClient.from(coll).delete();
            for (const [k, v] of Object.entries(dbQuery)) { req = req.eq(k, v); }
            req.then(({ error }) => {
                if (error) {
                    console.error(`[DB] Async delete ${coll}:`, error);
                    _warnMissingTables(error);
                }
            }).catch(err => console.error(`[DB] Async delete exception on ${coll}:`, err));
        }
        return deletedCount;
    }
};


// Seed LocalDB with defaults if empty (so app works out of the box)
function seedLocalDefaultData() {
    if (localStorage.getItem('db_seeded') === 'true') return;
    
    // 1. Seed Habits
    const defaultHabits = [
        { _id: "h1", name: "Acordar antes de 6:15 ⏰", category: "manha" },
        { _id: "h2", name: "Café ☕", category: "alimentos" },
        { _id: "h3", name: "Creatina 🧪", category: "alimentos" },
        { _id: "h4", name: "Remédios 💊", category: "alimentos" },
        { _id: "h5", name: "Pão com Ovo 🍳", category: "alimentos" },
        { _id: "h6", name: "Escovar os Dentes 1 🪥", category: "higiene" },
        { _id: "h7", name: "Protetor solar ☀️", category: "higiene" },
        { _id: "h8", name: "Sabonete gel anti acne 🧼", category: "higiene" },
        { _id: "h9", name: "Cicatricure Creme Corporal 🧴", category: "higiene" },
        { _id: "h10", name: "Escovar os Dentes 2 🪥", category: "tarde" },
        { _id: "h11", name: "1h de Projeto 💻", category: "projeto" },
        { _id: "h12", name: "Academia 🏋️", category: "projeto" },
        { _id: "h13", name: "Banho assim que chegar 🚿", category: "higiene" },
        { _id: "h14", name: "Bio-Oil (depois do último banho) 🧴", category: "higiene" },
        { _id: "h15", name: "Sabonete gel anti acne (Tarde) 🧼", category: "higiene" },
        { _id: "h16", name: "Escovar Dentes 3 🪥", category: "noite" },
        { _id: "h17", name: "Meditar 🧘", category: "noite" },
        { _id: "h18", name: "Anotações e Pesquisas 📝", category: "noite" },
        { _id: "h19", name: "Cenário 🎬", category: "noite" },
        { _id: "h20", name: "Ir Dormir 21h 😴", category: "noite" },
        { _id: "h21", name: "Estar dormindo 22h 💤", category: "noite" },
        { _id: "h22", name: "Beber 4 litros de água 💧", category: "geral" },
        { _id: "h23", name: "Sem Vício 🚫", category: "geral" }
    ];
    LocalDB.set('habits', defaultHabits);

    // 2. Seed Monthly Tasks
    const defaultMonthlyTasks = [
        { _id: "mt1", month: "2026-07", weekOfMonth: 0, text: "Define monthly main objective", completed: true },
        { _id: "mt2", month: "2026-07", weekOfMonth: 0, text: "Set up targets and metrics", completed: true },
        { _id: "mt3", month: "2026-07", weekOfMonth: 0, text: "First week check-in", completed: true },
        { _id: "mt4", month: "2026-07", weekOfMonth: 0, text: "Organize digital folders", completed: false },
        { _id: "mt5", month: "2026-07", weekOfMonth: 1, text: "Review budget & expenses", completed: true },
        { _id: "mt6", month: "2026-07", weekOfMonth: 1, text: "Check progress of habits", completed: true },
        { _id: "mt7", month: "2026-07", weekOfMonth: 1, text: "Mid-month checkpoint", completed: false },
        { _id: "mt8", month: "2026-07", weekOfMonth: 2, text: "Analyze energy levels trends", completed: false },
        { _id: "mt9", month: "2026-07", weekOfMonth: 2, text: "Optimize routine/schedule", completed: false },
        { _id: "mt10", month: "2026-07", weekOfMonth: 3, text: "Begin monthly evaluation", completed: false },
        { _id: "mt11", month: "2026-07", weekOfMonth: 3, text: "Backup critical system files", completed: false }
    ];
    LocalDB.set('monthly_tasks', defaultMonthlyTasks);

    // 3. Seed Relapse Data
    LocalDB.set('last_fall', [{ _id: "lf1", date: new Date('2026-07-01T00:00:00.000Z').toISOString() }]);
    
    // 4. Seed Daily Notes
    const todayStr = new Date().toISOString().split('T')[0];
    const defaultNotes = [
        {
            _id: "dn1",
            date: todayStr,
            content: "Hoje o dia foi produtivo. Foquei bastante na reestruturação do layout mobile da aplicação e consegui resolver o bug de overflow. Consegui manter a rotina de exercícios físicos também. Amanhã é manter o foco!",
            mood: "🚀",
            tags: ["produtividade", "estudos", "treino"]
        }
    ];
    LocalDB.set('daily_notes', defaultNotes);

    localStorage.setItem('db_seeded', 'true');
    console.log("[LocalDB] Seeded default habits and tasks successfully.");
}

// Supabase Connection Settings Manager
function updateSupabaseStatus(connected) {
    const statusEl = document.getElementById('supabase-sync-status');
    if (!statusEl) return;
    
    if (connected) {
        statusEl.textContent = localStorage.getItem('app-lang') === 'pt' ? 'Conectado' : 'Connected';
        statusEl.style.backgroundColor = 'rgba(16, 185, 129, 0.15)';
        statusEl.style.color = '#34d399';
        statusEl.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    } else {
        statusEl.textContent = localStorage.getItem('app-lang') === 'pt' ? 'Desconectado' : 'Disconnected';
        statusEl.style.backgroundColor = 'rgba(239, 68, 68, 0.15)';
        statusEl.style.color = '#f87171';
        statusEl.style.borderColor = 'rgba(239, 68, 68, 0.3)';
    }
}

function initSupabase() {
    const url = localStorage.getItem('supabase_url');
    const key = localStorage.getItem('supabase_key');
    
    // Populate form inputs if they exist
    const urlInput = document.getElementById('supabase-url-input');
    const keyInput = document.getElementById('supabase-key-input');
    if (urlInput) urlInput.value = url || '';
    if (keyInput) keyInput.value = key || '';

    if (url && key && window.supabase) {
        try {
            supabaseClient = window.supabase.createClient(url, key);
            updateSupabaseStatus(true);
            
            // Sync all collections from Supabase in the background
            syncAllCollections();
        } catch (err) {
            console.error("Failed to initialize Supabase:", err);
            updateSupabaseStatus(false);
        }
    } else {
        updateSupabaseStatus(false);
    }
}

function saveSupabaseConfig() {
    const url = document.getElementById('supabase-url-input').value.trim();
    const key = document.getElementById('supabase-key-input').value.trim();
    
    if (!url || !key) {
        alert(localStorage.getItem('app-lang') === 'pt' ? "Por favor, preencha a URL e a Chave Anon do Supabase!" : "Please fill in both Supabase URL and Anon Key!");
        return;
    }
    
    localStorage.setItem('supabase_url', url);
    localStorage.setItem('supabase_key', key);
    
    alert(localStorage.getItem('app-lang') === 'pt' ? "Configurações salvas! Conectando..." : "Settings saved! Connecting...");
    initSupabase();
}

function clearSupabaseConfig() {
    localStorage.removeItem('supabase_url');
    localStorage.removeItem('supabase_key');
    supabaseClient = null;
    
    const urlInput = document.getElementById('supabase-url-input');
    const keyInput = document.getElementById('supabase-key-input');
    if (urlInput) urlInput.value = '';
    if (keyInput) keyInput.value = '';
    
    updateSupabaseStatus(false);
    alert(localStorage.getItem('app-lang') === 'pt' ? "Supabase desconectado com sucesso." : "Supabase disconnected successfully.");
}

// On connect: upload any pending local data to Supabase, then refresh the UI.
// Since SupabaseDB now reads directly from Supabase, no local→cloud merge is needed for normal operation.
async function syncAllCollections() {
    if (!supabaseClient) return;
    console.log("[DB] Supabase connected. Checking for pending local data to upload...");
    
    const collections = ['habits', 'habit_entries', 'mental_state', 'tasks', 'monthly_tasks', 'mindset_tracker', 'last_fall', 'relapse_history', 'daily_notes'];
    for (const coll of collections) {
        try {
            dbSchemaStyle[coll] = dbSchemaStyle[coll] || { pk: '_id', case: 'camelcase' };
            
            let cloudData = null;
            let checkRes = await supabaseClient.from(coll).select('_id').limit(1);
            if (checkRes.error) {
                // Check if the column is 'id' instead of '_id' (common when tables are created via Supabase UI)
                let checkRes2 = await supabaseClient.from(coll).select('id').limit(1);
                if (!checkRes2.error) {
                    dbSchemaStyle[coll].pk = 'id';
                    cloudData = checkRes2.data;
                } else {
                    console.error(`[DB] Check error on ${coll}:`, checkRes.error);
                    _warnMissingTables(checkRes.error);
                    continue;
                }
            } else {
                dbSchemaStyle[coll].pk = '_id';
                cloudData = checkRes.data;
            }
            
            if (cloudData && cloudData.length > 0) {
                detectSchemaStyle(coll, cloudData[0]);
            }
            
            // Only upload local data if cloud collection is completely empty (first-time setup)
            if (!cloudData || cloudData.length === 0) {
                const localData = LocalDB.get(coll);
                if (localData && localData.length > 0) {
                    const sanitizedData = localData.map(item => normalizeToSupabase(coll, item));
                    const { error: upErr } = await supabaseClient.from(coll).upsert(sanitizedData);
                    if (upErr) {
                        console.error(`[DB] Upload error for ${coll}:`, upErr);
                        _warnMissingTables(upErr);
                    }
                    else console.log(`[DB] Uploaded ${localData.length} records to ${coll}`);
                }
            } else {
                // Cloud has data. Download all data from cloud and overwrite/update LocalDB cache
                const { data: allCloudData, error: pullErr } = await supabaseClient.from(coll).select('*');
                if (pullErr) {
                    console.error(`[DB] Pull error for ${coll}:`, pullErr);
                    _warnMissingTables(pullErr);
                } else if (allCloudData) {
                    const normalizedData = allCloudData.map(item => normalizeFromSupabase(coll, item));
                    LocalDB.set(coll, normalizedData);
                    console.log(`[DB] Cached ${normalizedData.length} records from Supabase for ${coll}`);
                }
            }
        } catch (err) {
            console.error(`[DB] Sync error on ${coll}:`, err);
        }
    }
    
    console.log("[DB] Initial sync complete. Supabase is now the primary database.");
    
    // Refresh the currently visible page so it loads from Supabase
    const activePage = document.querySelector('.dashboard-page.active');
    if (activePage) {
        const id = activePage.id;
        if (id === 'page-habit-tracker') loadHabitTrackerData();
        else if (id === 'page-task-tracker') loadTaskTrackerData();
        else if (id === 'page-monthly-tracker') loadMonthlyTrackerData();
        else if (id === 'page-data-manager') loadCrudData();
        else if (id === 'page-relapse-tracker') loadRelapseData();
        else if (id === 'page-daily-notes') loadDailyNotesData();
    }
}

// API ROUTER — routes through SupabaseDB (Supabase when connected, localStorage when offline)
async function handleLocalApiRequest(url, options) {
    const method = options.method || 'GET';
    const parsedUrl = new URL(url, window.location.origin);
    const pathname = parsedUrl.pathname;
    const body = options.body ? JSON.parse(options.body) : {};

    // 1. Habits API
    if (pathname === '/api/habits') {
        if (method === 'GET') {
            return await SupabaseDB.find('habits');
        } else if (method === 'POST') {
            return await SupabaseDB.insert('habits', body);
        }
    }
    if (pathname.startsWith('/api/habits/')) {
        const id = pathname.split('/').pop();
        if (method === 'POST') {
            await SupabaseDB.update('habits', { _id: id }, body);
            return { success: true };
        } else if (method === 'DELETE') {
            await SupabaseDB.delete('habits', { _id: id });
            return { success: true };
        }
    }

    // 2. Habit Entries API
    if (pathname === '/api/habit-entries') {
        if (method === 'GET') {
            const month = parsedUrl.searchParams.get('month');
            if (supabaseClient) {
                supabaseClient.from('habit_entries').select('*').like('date', `${month}%`)
                    .then(({ data, error }) => {
                        if (error) console.error('[DB] Background habit-entries GET:', error);
                        else if (data) {
                            const cached = LocalDB.get('habit_entries');
                            data.forEach(item => {
                                const normItem = normalizeFromSupabase('habit_entries', item);
                                const idx = cached.findIndex(x => x._id === normItem._id);
                                if (idx !== -1) cached[idx] = normItem;
                                else cached.push(normItem);
                            });
                            LocalDB.set('habit_entries', cached);
                        }
                    })
                    .catch(err => console.error('[DB] Background habit-entries GET exception:', err));
            }
            return LocalDB._find('habit_entries').filter(e => e.date.startsWith(month));
        }
    }
    if (pathname === '/api/habit-entries/toggle') {
        if (method === 'POST') {
            const { habitId, date, completed } = body;
            const existing = await SupabaseDB.findOne('habit_entries', { habitId, date });
            let isCompleted;
            if (existing) {
                isCompleted = !existing.completed;
                await SupabaseDB.update('habit_entries', { _id: existing._id }, { completed: isCompleted });
            } else {
                isCompleted = (completed !== undefined) ? !!completed : true;
                await SupabaseDB.insert('habit_entries', { habitId, date, completed: isCompleted });
            }
            return { success: true, completed: isCompleted };
        }
    }

    // 3. Mental State API
    if (pathname === '/api/mental-state') {
        if (method === 'GET') {
            const month = parsedUrl.searchParams.get('month');
            if (supabaseClient) {
                let req = supabaseClient.from('mental_state').select('*');
                if (month) req = req.like('date', `${month}%`);
                req.then(({ data, error }) => {
                    if (error) console.error('[DB] Background mental-state GET:', error);
                    else if (data) {
                        const cached = LocalDB.get('mental_state');
                        data.forEach(item => {
                            const normItem = normalizeFromSupabase('mental_state', item);
                            const idx = cached.findIndex(x => x._id === normItem._id);
                            if (idx !== -1) cached[idx] = normItem;
                            else cached.push(normItem);
                        });
                        LocalDB.set('mental_state', cached);
                    }
                }).catch(err => console.error('[DB] Background mental-state GET exception:', err));
            }
            const states = LocalDB._find('mental_state');
            return month ? states.filter(s => s.date.startsWith(month)) : states;
        } else if (method === 'POST') {
            const { date, mood, motivation } = body;
            const existing = await SupabaseDB.findOne('mental_state', { date });
            if (existing) {
                const updateObj = {};
                if (mood !== undefined) updateObj.mood = Number(mood);
                if (motivation !== undefined) updateObj.motivation = Number(motivation);
                await SupabaseDB.update('mental_state', { _id: existing._id }, updateObj);
            } else {
                await SupabaseDB.insert('mental_state', {
                    date,
                    mood: mood !== undefined ? Number(mood) : 5,
                    motivation: motivation !== undefined ? Number(motivation) : 5
                });
            }
            return { success: true };
        }
    }
    if (pathname.startsWith('/api/mental-state/')) {
        const dateStr = pathname.split('/').pop();
        if (method === 'DELETE') {
            await SupabaseDB.delete('mental_state', { date: dateStr });
            return { success: true };
        }
    }

    // 4. Tasks API
    if (pathname === '/api/tasks') {
        if (method === 'GET') {
            const weekStartDate = parsedUrl.searchParams.get('weekStartDate');
            return await SupabaseDB.find('tasks', { weekStartDate });
        } else if (method === 'POST') {
            const newTask = { completed: false, color: '#3b82f6', ...body };
            return await SupabaseDB.insert('tasks', newTask);
        }
    }
    if (pathname.startsWith('/api/tasks/')) {
        const id = pathname.split('/').pop();
        if (method === 'POST' || method === 'PUT') {
            await SupabaseDB.update('tasks', { _id: id }, body);
            return { success: true };
        } else if (method === 'DELETE') {
            await SupabaseDB.delete('tasks', { _id: id });
            return { success: true };
        }
    }

    // 5. Monthly Tasks API
    if (pathname === '/api/monthly-tasks') {
        if (method === 'GET') {
            const month = parsedUrl.searchParams.get('month');
            return await SupabaseDB.find('monthly_tasks', { month });
        } else if (method === 'POST') {
            return await SupabaseDB.insert('monthly_tasks', body);
        }
    }
    if (pathname.startsWith('/api/monthly-tasks/')) {
        const id = pathname.split('/').pop();
        if (method === 'POST' || method === 'PUT') {
            await SupabaseDB.update('monthly_tasks', { _id: id }, body);
            return { success: true };
        } else if (method === 'DELETE') {
            await SupabaseDB.delete('monthly_tasks', { _id: id });
            return { success: true };
        }
    }

    // 6. Mindset Tracker API
    if (pathname === '/api/mindset-tracker') {
        if (method === 'GET') {
            const weekStartDate = parsedUrl.searchParams.get('weekStartDate');
            return await SupabaseDB.find('mindset_tracker', { weekStartDate });
        } else if (method === 'POST') {
            const { weekStartDate, dayOfWeek, energy, focus, motivation } = body;
            const existing = await SupabaseDB.findOne('mindset_tracker', { weekStartDate, dayOfWeek: Number(dayOfWeek) });
            if (existing) {
                await SupabaseDB.update('mindset_tracker', { _id: existing._id }, { energy, focus, motivation });
            } else {
                await SupabaseDB.insert('mindset_tracker', { weekStartDate, dayOfWeek: Number(dayOfWeek), energy, focus, motivation });
            }
            return { success: true };
        }
    }

    // 7. Last Fall (Sobriety) API
    if (pathname === '/api/last-fall') {
        if (method === 'GET') {
            let active = await SupabaseDB.findOne('last_fall', {});
            if (!active) {
                active = await SupabaseDB.insert('last_fall', { date: new Date('2026-01-01T00:00:00.000Z').toISOString() });
            }
            const history = await SupabaseDB.find('relapse_history');
            return { lastFall: active.date, history: history || [] };
        } else if (method === 'POST') {
            const { date } = body;
            const active = await SupabaseDB.findOne('last_fall', {});
            if (active) {
                const durationMs = new Date(date) - new Date(active.date);
                if (durationMs > 0) {
                    await SupabaseDB.insert('relapse_history', { startDate: active.date, endDate: date, durationMs });
                }
                await SupabaseDB.update('last_fall', { _id: active._id }, { date });
            } else {
                await SupabaseDB.insert('last_fall', { date });
            }
            return { success: true };
        }
    }
    if (pathname.startsWith('/api/relapse-history/')) {
        const id = pathname.split('/').pop();
        if (method === 'DELETE') {
            await SupabaseDB.delete('relapse_history', { _id: id });
            return { success: true };
        }
    }

    // 8. Daily Notes API
    if (pathname === '/api/daily-notes') {
        if (method === 'GET') {
            return await SupabaseDB.find('daily_notes');
        } else if (method === 'POST') {
            const { date, content, mood, tags } = body;
            const existing = await SupabaseDB.findOne('daily_notes', { date });
            if (existing) {
                await SupabaseDB.update('daily_notes', { _id: existing._id }, { content, mood, tags });
            } else {
                await SupabaseDB.insert('daily_notes', { date, content, mood, tags });
            }
            return { success: true };
        }
    }
    if (pathname.startsWith('/api/daily-notes/')) {
        const dateStr = pathname.split('/').pop();
        if (method === 'DELETE') {
            await SupabaseDB.delete('daily_notes', { date: dateStr });
            return { success: true };
        }
    }

    // 9. Admin: Clear All
    if (pathname === '/api/admin/clear-all') {
        const collections = ['habits', 'habit_entries', 'mental_state', 'tasks', 'monthly_tasks', 'mindset_tracker', 'last_fall', 'relapse_history', 'daily_notes'];
        // Clear localStorage
        for (const coll of collections) LocalDB.set(coll, []);
        localStorage.removeItem('db_seeded');
        // Clear Supabase (await each to confirm)
        if (supabaseClient) {
            for (const coll of collections) {
                const { error } = await supabaseClient.from(coll).delete().neq('_id', '');
                if (error) console.error(`[DB] Clear error on ${coll}:`, error);
            }
        }
        return { success: true, backupPath: 'Supabase + LocalStorage' };
    }

    // 10. Admin: Seed Test Data
    if (pathname === '/api/admin/seed-test-data') {
        localStorage.removeItem('db_seeded');
        seedLocalDefaultData();
        if (supabaseClient) syncAllCollections();
        return { success: true };
    }

    throw new Error(`Endpoint not simulated: ${method} ${pathname}`);
}

// Intercept window.fetch globally to allow 100% serverless static build
const nativeFetch = window.fetch;
window.fetch = async function(url, options = {}) {
    const urlStr = typeof url === 'string' ? url : url.url;
    if (urlStr.startsWith('/api/')) {
        try {
            const result = await handleLocalApiRequest(urlStr, options);
            return new Response(JSON.stringify(result), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (err) {
            console.error("Local Mock API Error:", err);
            return new Response(JSON.stringify({ error: err.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }
    return nativeFetch.apply(this, arguments);
};

// Auto seed on initial script load
seedLocalDefaultData();

function getDaysInCurrentMonth() {
    const parts = currentMonth.split('-');
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    return new Date(year, month, 0).getDate();
}

// Multilingual Month Names Helper
function getMonthNames() {
    const currentLang = localStorage.getItem('app-lang') || 'en';
    if (currentLang === 'pt') {
        return [
            "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
            "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
        ];
    }
    return [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ];
}

// Picker Year State (Tracks the visible year in the dropdown panels)
const pickerYearState = {
    habit: _curY,
    task: _curY,
    monthly: _curY,
    notes: _curY
};

// Toggle Custom Month Picker Dropdown Visibility
function toggleMonthPicker(pickerType) {
    const container = document.getElementById(`${pickerType}-month-picker-container`);
    if (!container) return;
    
    const isOpen = container.classList.contains('open');
    
    // Close other pickers
    document.querySelectorAll('.custom-month-picker').forEach(el => {
        el.classList.remove('open');
    });
    
    if (!isOpen) {
        container.classList.add('open');
        
        // Initialize the temporary year shown in the dropdown
        let activeDateVal;
        if (pickerType === 'habit') {
            activeDateVal = currentMonth;
        } else if (pickerType === 'task') {
            activeDateVal = currentTaskMonth;
        } else if (pickerType === 'monthly') {
            activeDateVal = currentMonthlyTrackerMonth;
        } else if (pickerType === 'notes') {
            activeDateVal = currentNotesMonth;
        }
        
        const year = parseInt(activeDateVal.split('-')[0], 10);
        pickerYearState[pickerType] = year;
        
        renderCustomPicker(pickerType);
    }
}

// Change year in the picker dropdown
function changePickerYear(pickerType, delta) {
    pickerYearState[pickerType] += delta;
    renderCustomPicker(pickerType);
}

// Populate the month grid in the picker dropdown
function renderCustomPicker(pickerType) {
    const yearLabel = document.getElementById(`${pickerType}-picker-year`);
    if (yearLabel) {
        yearLabel.textContent = pickerYearState[pickerType];
    }
    
    const grid = document.getElementById(`${pickerType}-month-grid`);
    if (!grid) return;
    
    grid.innerHTML = '';
    const months = getMonthNames();
    const shortMonths = months.map(m => m.substring(0, 3));
    
    let activeDateVal;
    if (pickerType === 'habit') {
        activeDateVal = currentMonth;
    } else if (pickerType === 'task') {
        activeDateVal = currentTaskMonth;
    } else if (pickerType === 'monthly') {
        activeDateVal = currentMonthlyTrackerMonth;
    } else if (pickerType === 'notes') {
        activeDateVal = currentNotesMonth;
    }
    
    const [actYear, actMonth] = activeDateVal.split('-').map(Number);
    
    const today = new Date();
    const todayY = today.getFullYear();
    const todayM = today.getMonth() + 1;
    
    for (let mIdx = 0; mIdx < 12; mIdx++) {
        const monthNum = mIdx + 1;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mpd-month-btn';
        btn.textContent = shortMonths[mIdx];
        
        // Active selection highlighting
        if (pickerYearState[pickerType] === actYear && monthNum === actMonth) {
            btn.classList.add('active');
        }
        
        // Current system month highlighting
        if (pickerYearState[pickerType] === todayY && monthNum === todayM) {
            btn.classList.add('current-month');
        }
        
        btn.onclick = (e) => {
            e.stopPropagation();
            selectPickerMonth(pickerType, pickerYearState[pickerType], monthNum);
        };
        
        grid.appendChild(btn);
    }
}

// Handle month selection
function selectPickerMonth(pickerType, year, month) {
    const val = `${year}-${String(month).padStart(2, '0')}`;
    
    if (pickerType === 'habit') {
        onMonthPickerChange(val);
    } else if (pickerType === 'task') {
        onTaskMonthPickerChange(val);
    } else if (pickerType === 'monthly') {
        onMonthlyTrackerPickerChange(val);
    } else if (pickerType === 'notes') {
        onNotesMonthPickerChange(val);
    }
    
    // Close dropdowns
    document.querySelectorAll('.custom-month-picker').forEach(el => {
        el.classList.remove('open');
    });
}

// Habit Tracker month navigation functions
function adjustMonth(delta) {
    let [year, month] = currentMonth.split('-').map(Number);
    month += delta;
    if (month > 12) {
        month = 1;
        year += 1;
    } else if (month < 1) {
        month = 12;
        year -= 1;
    }
    const val = `${year}-${String(month).padStart(2, '0')}`;
    onMonthPickerChange(val);
}

function onMonthPickerChange(val) {
    if (!val) return;
    currentMonth = val;
    updateMonthTitle();
    loadHabitTrackerData();
}

function updateMonthTitle() {
    const parts = currentMonth.split('-');
    const year = parts[0];
    const monthIndex = parseInt(parts[1], 10) - 1;
    const months = getMonthNames();
    const titleEl = document.getElementById('habit-month-title');
    if (titleEl) {
        titleEl.textContent = `${months[monthIndex]} ${year}`;
    }
}

// Task Tracker month navigation functions
function adjustTaskMonth(delta) {
    let [year, month] = currentTaskMonth.split('-').map(Number);
    month += delta;
    if (month > 12) {
        month = 1;
        year += 1;
    } else if (month < 1) {
        month = 12;
        year -= 1;
    }
    const val = `${year}-${String(month).padStart(2, '0')}`;
    onTaskMonthPickerChange(val);
}

function onTaskMonthPickerChange(val) {
    if (!val) return;
    currentTaskMonth = val;
    updateTaskMonthTitle();
    
    // Auto-set currentWeekStart to the first Sunday on or after the 1st of the selected month
    const [year, month] = val.split('-').map(Number);
    const firstDay = new Date(year, month - 1, 1);
    const dayOfWeek = firstDay.getDay(); // 0 = Sunday
    
    const sundayDate = new Date(firstDay);
    const daysToAdd = (7 - dayOfWeek) % 7;
    sundayDate.setDate(firstDay.getDate() + daysToAdd);
    
    const yStr = sundayDate.getFullYear();
    const mStr = String(sundayDate.getMonth() + 1).padStart(2, '0');
    const dStr = String(sundayDate.getDate()).padStart(2, '0');
    currentWeekStart = `${yStr}-${mStr}-${dStr}`;
    
    const weekInput = document.getElementById('week-start-date');
    if (weekInput) {
        weekInput.value = currentWeekStart;
    }
    updateWeekDisplay(currentWeekStart);
    loadTaskTrackerData();
}

function updateTaskMonthTitle() {
    const parts = currentTaskMonth.split('-');
    const year = parts[0];
    const monthIndex = parseInt(parts[1], 10) - 1;
    const months = getMonthNames();
    const titleEl = document.getElementById('task-month-title');
    if (titleEl) {
        titleEl.textContent = `${months[monthIndex]} ${year}`;
    }
}

function loadWeeklyTasks() {
    loadTaskTrackerData();
}

// Close custom month pickers when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-month-picker')) {
        document.querySelectorAll('.custom-month-picker').forEach(el => {
            el.classList.remove('open');
        });
    }
});

let habits = [];
let habitEntries = [];
let mentalStates = [];
let weeklyTasks = [];
let weeklyMindset = [];
let monthlyTasks = [];
let currentMonthlyTrackerMonth = `${_curY}-${_curM}`; // Format YYYY-MM

// Chart Instances
let habitTrendChartInstance = null;
let mentalTrendChartInstance = null;
let mindsetVariablesChartInstance = null;
let weeklyProgressBarsInstance = null;
let weeklyMindsetChartInstance = null;
let monthlyProgressBarsInstance = null;

const translations = {
    en: {
        user_role: "Premium Workspace",
        confirm_delete_task: "Are you sure you want to delete this task?",
        confirm_delete_habit: "Are you sure you want to delete this habit and all its history?",
        confirm_delete_mental: "Are you sure you want to delete the mental state log for ",
        confirm_delete_relapse: "Are you sure you want to delete this relapse record from history? This will delete the streak duration record.",
        confirm_relapse_now: "Are you sure you want to reset the counter to right now? This will save your current streak to history.",
        confirm_delete_note: "Are you sure you want to delete the daily note for ",
        btn_add: "Add",
        status_pending: "Pending",
        status_completed: "Completed"
    },
    pt: {
        user_role: "Espaço de Trabalho Premium",
        confirm_delete_task: "Tem certeza de que deseja excluir esta tarefa?",
        confirm_delete_habit: "Tem certeza de que deseja excluir este hábito e todo o seu histórico?",
        confirm_delete_mental: "Tem certeza de que deseja excluir o log de estado mental de ",
        confirm_delete_relapse: "Tem certeza de que deseja excluir este registro de queda do histórico? Isso excluirá o registro de duração.",
        confirm_relapse_now: "Tem certeza de que deseja reiniciar o contador para agora mesmo? Isso salvará sua sequência atual no histórico.",
        confirm_delete_note: "Tem certeza de que deseja excluir a nota diária de ",
        btn_add: "Adicionar",
        status_pending: "Pendente",
        status_completed: "Concluída"
    }
};

function toggleLanguage() {
    const currentLang = localStorage.getItem('app-lang') || 'en';
    const nextLang = currentLang === 'en' ? 'pt' : 'en';
    localStorage.setItem('app-lang', nextLang);
    applyTranslations();
    updateMonthTitle();
    updateTaskMonthTitle();
    updateMonthlyTrackerTitle();
    updateNotesMonthTitle();
    applyTheme();
    
    // Refresh current page view
    const activePage = document.querySelector('.dashboard-page.active');
    if (activePage) {
        const id = activePage.id;
        if (id === 'page-habit-tracker') {
            loadHabitTrackerData();
        } else if (id === 'page-task-tracker') {
            loadTaskTrackerData();
        } else if (id === 'page-monthly-tracker') {
            loadMonthlyTrackerData();
        } else if (id === 'page-data-manager') {
            loadCrudData();
        } else if (id === 'page-relapse-tracker') {
            loadRelapseData();
        } else if (id === 'page-focus-canvas') {
            renderCanvasTodos();
        } else if (id === 'page-daily-notes') {
            loadDailyNotesData();
        }
    }
}

function toggleTheme() {
    const currentTheme = localStorage.getItem('app-theme') || 'default';
    const nextTheme = currentTheme === 'default' ? 'classic-dark' : 'default';
    localStorage.setItem('app-theme', nextTheme);
    applyTheme();
}

function applyTheme() {
    const currentTheme = localStorage.getItem('app-theme') || 'default';
    const currentLang = localStorage.getItem('app-lang') || 'en';
    const btnText = document.getElementById('theme-btn-text');
    const btnIcon = document.getElementById('theme-btn-icon');
    
    if (currentTheme === 'classic-dark') {
        document.body.classList.add('theme-classic-dark');
        if (btnText) {
            btnText.textContent = currentLang === 'pt' ? 'Padrão' : 'Base';
        }
        if (btnIcon) {
            btnIcon.className = "fa-solid fa-sun";
            btnIcon.style.color = "#f59e0b";
        }
    } else {
        document.body.classList.remove('theme-classic-dark');
        if (btnText) {
            btnText.textContent = currentLang === 'pt' ? 'Clássico' : 'Classic';
        }
        if (btnIcon) {
            btnIcon.className = "fa-solid fa-moon";
            btnIcon.style.color = "#eab308";
        }
    }
}

function applyTranslations() {
    const currentLang = localStorage.getItem('app-lang') || 'en';
    
    // Update language switch button text (display the opposite language option)
    const langBtnText = document.getElementById('lang-btn-text');
    if (langBtnText) {
        langBtnText.textContent = currentLang === 'en' ? 'PT-BR' : 'EN';
    }

    const textMap = {
        // Sidebar
        '#nav-habit-tracker span': currentLang === 'pt' ? 'Hábitos' : 'Habit Tracker',
        '#nav-task-tracker span': currentLang === 'pt' ? 'Tarefas' : 'Task Tracker',
        '#nav-monthly-tracker span': currentLang === 'pt' ? 'Tracker Mensal' : 'Monthly Tracker',
        '#nav-data-manager span': currentLang === 'pt' ? 'Gerenciar Dados (CRUD)' : 'Manage Data (CRUD)',
        '#nav-relapse-tracker span': currentLang === 'pt' ? 'Sobriedade' : 'Sobriety Counter',
        '.user-role': currentLang === 'pt' ? 'Espaço de Trabalho Premium' : 'Premium Workspace',
        
        // Habit Tracker
        '#page-habit-tracker .subtitle': currentLang === 'pt' ? '- Rastreador de Hábitos -' : '- Habit Tracker -',
        '#page-habit-tracker .metric-card:nth-child(1) .metric-label': currentLang === 'pt' ? 'Número de hábitos' : 'Number of habits',
        '#page-habit-tracker .metric-card:nth-child(2) .metric-label': currentLang === 'pt' ? 'Hábitos concluídos' : 'Completed habits',
        '#page-habit-tracker .metric-card:nth-child(3) .metric-label': currentLang === 'pt' ? 'Progresso' : 'Progress',
        '#my-habits-section h2': currentLang === 'pt' ? 'Meus Hábitos' : 'My Habits',
        '#my-habits-section .action-btn': currentLang === 'pt' ? '<i class="fa-solid fa-plus"></i> Novo Hábito' : '<i class="fa-solid fa-plus"></i> Add Habit',
        '#page-habit-tracker .chart-card:nth-of-type(1) h2': currentLang === 'pt' ? 'Tendência de Hábitos' : 'Habit Progress Trend',
        '#page-habit-tracker .chart-card:nth-of-type(2) h2': currentLang === 'pt' ? 'Tendência de Humor e Motivação' : 'Mood & Motivation Trend',
        '#page-habit-tracker .dashboard-card:nth-of-type(4) h2': currentLang === 'pt' ? 'Rastreador de Variáveis de Mentalidade' : 'Mindset Variables Tracker',
        '#page-habit-tracker .dashboard-card:nth-of-type(4) .card-subtitle': currentLang === 'pt' ? 'Médias mensais compiladas a partir de logs diários de estado mental' : 'Monthly averages compiled from daily mental state logs',
        '#page-habit-tracker .dashboard-card:nth-of-type(4) .stat-box:nth-child(1) .stat-label': currentLang === 'pt' ? 'Foco (Humor)' : 'Focus (Mood)',
        '#page-habit-tracker .dashboard-card:nth-of-type(4) .stat-box:nth-child(2) .stat-label': currentLang === 'pt' ? 'Motivação' : 'Motivation',
        '#page-habit-tracker .dashboard-card:nth-of-type(4) .stat-box:nth-child(3) .stat-label': currentLang === 'pt' ? 'Média de Energia' : 'Energy (Score)',
        
        // Task Tracker
        '#page-task-tracker h1': currentLang === 'pt' ? 'Rastreador de Tarefas' : 'Task Tracker',
        '#page-task-tracker .page-header .subtitle': currentLang === 'pt' ? '- Organização Semanal -' : '- Weekly Organization -',
        '#page-task-tracker label[for="week-start-date"]': currentLang === 'pt' ? 'Semana iniciando em:' : 'Week Starting:',
        '#page-task-tracker .dashboard-card:nth-of-type(1) h2': currentLang === 'pt' ? 'Resumo de Progresso Semanal' : 'Weekly Progress Summary',
        '#page-task-tracker .radial-gauge-side .gauge-label': currentLang === 'pt' ? 'Total Concluído' : 'Total Completed',
        '#page-task-tracker .dashboard-card:nth-of-type(2) h2': currentLang === 'pt' ? 'Mindset Semanal' : 'Weekly Mindset Tracker',
        
        // CRUD Manager
        '#page-data-manager h1': currentLang === 'pt' ? 'Gerenciador de Dados' : 'Data Manager (CRUD)',
        '#page-data-manager .page-header .subtitle': currentLang === 'pt' ? '- Banco de Dados -' : '- System Logs Database -',
        '#tab-btn-habits': currentLang === 'pt' ? 'Hábitos' : 'Habits',
        '#tab-btn-tasks': currentLang === 'pt' ? 'Tarefas' : 'Tasks',
        '#tab-btn-mental': currentLang === 'pt' ? 'Estado Mental' : 'Mental State',
        '#filter-habits-name': currentLang === 'pt' ? 'Buscar hábitos por nome...' : 'Search habits by name...',
        '#filter-tasks-text': currentLang === 'pt' ? 'Buscar tarefas...' : 'Search tasks...',
        '#filter-mental-mood': currentLang === 'pt' ? 'Humor Mín (1-10)' : 'Min Mood (1-10)',
        '#filter-mental-motiv': currentLang === 'pt' ? 'Motiv Mín (1-10)' : 'Min Motiv (1-10)',
        '#crud-habits .crud-filters select option[value=""]': currentLang === 'pt' ? 'Todas Categorias' : 'All Categories',
        '#crud-tasks .crud-filters select option[value=""]': currentLang === 'pt' ? 'Todos Statuses' : 'All Statuses',
        '#crud-tasks .crud-filters select option[value="completed"]': currentLang === 'pt' ? 'Concluídas' : 'Completed',
        '#crud-tasks .crud-filters select option[value="pending"]': currentLang === 'pt' ? 'Pendentes' : 'Pending',
        '#crud-tasks label[for="crud-task-week"]': currentLang === 'pt' ? 'Semana iniciando:' : 'Week Starting:',
        '#crud-mental label[for="crud-mental-month"]': currentLang === 'pt' ? 'Mês:' : 'Month:',
        
        // Sobriety Counter
        '#page-relapse-tracker h1': currentLang === 'pt' ? 'Contador de Sobriedade' : 'Sobriety Counter',
        '#page-relapse-tracker .page-header .subtitle': currentLang === 'pt' ? '- Tempo Desde a Última Queda -' : '- Time Since Last Relapse -',
        '#page-relapse-tracker .dashboard-card:nth-of-type(1) h2': currentLang === 'pt' ? 'Tempo Desde a Última Queda' : 'Time Since Last Fall',
        '#page-relapse-tracker .counter-variables-grid > div:nth-child(1) > div:nth-child(2)': currentLang === 'pt' ? 'Dias Totais' : 'Total Days',
        '#page-relapse-tracker .counter-variables-grid > div:nth-child(2) > div:nth-child(2)': currentLang === 'pt' ? 'Horas Totais' : 'Total Hours',
        '#page-relapse-tracker .counter-variables-grid > div:nth-child(3) > div:nth-child(2)': currentLang === 'pt' ? 'Minutos Totais' : 'Total Minutes',
        '#page-relapse-tracker .counter-variables-grid > div:nth-child(4) > div:nth-child(2)': currentLang === 'pt' ? 'Segundos Totais' : 'Total Seconds',
        '#page-relapse-tracker .dashboard-card:nth-of-type(2) h2': currentLang === 'pt' ? 'Registrar Queda Retroativa' : 'Log Relapse Manually',
        '#page-relapse-tracker .dashboard-card:nth-of-type(2) .card-subtitle': currentLang === 'pt' ? 'Você recaiu em alguma data ou hora passada? Registre aqui.' : 'Did you relapse at a past date or time? Register it here.',
        '#page-relapse-tracker label[for="manual-relapse-datetime"]': currentLang === 'pt' ? 'Data e Hora da Queda:' : 'Relapse Date & Time:',
        '#page-relapse-tracker button[type="submit"]': currentLang === 'pt' ? '<i class="fa-solid fa-calendar-plus" style="margin-right: 8px;"></i> Salvar Queda Passada' : '<i class="fa-solid fa-calendar-plus" style="margin-right: 8px;"></i> Save Past Relapse',
        '#page-relapse-tracker .dashboard-card[style*="border-top: 4px solid #a855f7"] h2': currentLang === 'pt' ? 'Estatísticas de Sequência' : 'Streak Stats',
        '#page-relapse-tracker .dashboard-card[style*="border-top: 4px solid #a855f7"] div:nth-child(1) span:first-child': currentLang === 'pt' ? 'Sequência Atual:' : 'Current Streak:',
        '#page-relapse-tracker .dashboard-card[style*="border-top: 4px solid #a855f7"] div:nth-child(2) span:first-child': currentLang === 'pt' ? 'Maior Recorde:' : 'Longest Streak:',
        '#page-relapse-tracker .dashboard-card[style*="border-top: 4px solid #a855f7"] div:nth-child(3) span:first-child': currentLang === 'pt' ? 'Média de Sequência:' : 'Average Streak:',
        '#page-relapse-tracker .dashboard-card[style*="border-top: 4px solid var(--primary-red)"] h2': currentLang === 'pt' ? 'Histórico de Quedas' : 'Relapse History',
        '#page-relapse-tracker th:nth-child(1)': currentLang === 'pt' ? 'Data' : 'Date',
        '#page-relapse-tracker th:nth-child(2)': currentLang === 'pt' ? 'Duração' : 'Duration',
        '#page-relapse-tracker th:nth-child(3)': currentLang === 'pt' ? 'Ação' : 'Action',
        '#page-relapse-tracker .relapse-action-row button': currentLang === 'pt' ? '<i class="fa-solid fa-fire"></i> Eu Recaí Agora Mesmo!' : '<i class="fa-solid fa-fire"></i> I Relapsed Just Now!',
        
        // Add Habit modal
        '#add-habit-modal h3': currentLang === 'pt' ? 'Adicionar Novo Hábito' : 'Add New Habit',
        '#add-habit-form label[for="habit-name"]': currentLang === 'pt' ? 'Nome do Hábito (com emoji!):' : 'Habit Name (with emoji!):',
        '#add-habit-form label[for="habit-category"]': currentLang === 'pt' ? 'Categoria:' : 'Category:',
        '#add-habit-form label[for="habit-color"]': currentLang === 'pt' ? 'Cor:' : 'Color:',
        '#add-habit-form .submit-btn': currentLang === 'pt' ? 'Salvar Hábito' : 'Save Habit',

        // Edit Habit modal
        '#edit-habit-modal h3': currentLang === 'pt' ? 'Editar Detalhes do Hábito' : 'Edit Habit Details',
        '#edit-habit-form label[for="edit-habit-name"]': currentLang === 'pt' ? 'Nome do Hábito (com emoji!):' : 'Habit Name (with emoji!):',
        '#edit-habit-form label[for="edit-habit-category"]': currentLang === 'pt' ? 'Categoria:' : 'Category:',
        '#edit-habit-form .submit-btn': currentLang === 'pt' ? 'Salvar Alterações' : 'Save Changes',

        // Edit Task modal
        '#edit-task-modal h3': currentLang === 'pt' ? 'Editar Detalhes da Tarefa' : 'Edit Task Details',
        '#edit-task-form label[for="edit-task-text"]': currentLang === 'pt' ? 'Descrição da Tarefa:' : 'Task Description:',
        '#edit-task-form label[for="edit-task-day"]': currentLang === 'pt' ? 'Dia da Semana:' : 'Day of Week:',
        '#edit-task-form label[for="edit-task-color"]': currentLang === 'pt' ? 'Indicador de Cor:' : 'Color indicator:',
        '#edit-task-form label[for="edit-task-completed"]': currentLang === 'pt' ? 'Status:' : 'Status:',
        '#edit-task-form .submit-btn': currentLang === 'pt' ? 'Salvar Alterações' : 'Save Changes',

        // Edit Mental Modal
        '#edit-day-mindset-modal h3': currentLang === 'pt' ? 'Editar Mentalidade Diária' : 'Edit Daily Mindset (Tasks Page)',
        '#edit-day-mindset-form label[for="edit-mindset-energy"]': currentLang === 'pt' ? 'Energia (1 - 10):' : 'Energy (1 - 10):',
        '#edit-day-mindset-form label[for="edit-mindset-focus"]': currentLang === 'pt' ? 'Foco (1 - 10):' : 'Focus (1 - 10):',
        '#edit-day-mindset-form label[for="edit-mindset-motivation"]': currentLang === 'pt' ? 'Motivação (1 - 10):' : 'Motivation (1 - 10):',
        '#edit-day-mindset-form .submit-btn': currentLang === 'pt' ? 'Salvar Alterações' : 'Save Changes',

        // Focus Canvas
        '#nav-focus-canvas span': currentLang === 'pt' ? 'Canvas de Foco' : 'Focus Canvas',
        '#page-focus-canvas h1': currentLang === 'pt' ? 'Canvas de Foco' : 'Focus Canvas',
        '#page-focus-canvas .subtitle': currentLang === 'pt' ? '- Espaço de Produtividade Estético -' : '- Aesthetic Productivity Space -',
        '#page-focus-canvas button[onclick="resetCanvasLayout()"] span': currentLang === 'pt' ? 'Resetar Layout' : 'Reset Layout',
        '#widget-timer span[data-i18n="widget_timer_title"]': currentLang === 'pt' ? 'Cronômetro de Foco' : 'Focus Timer',
        '#widget-notes span[data-i18n="widget_notes_title"]': currentLang === 'pt' ? 'Post-it Virtual' : 'Sticky Note',
        '#widget-media span[data-i18n="widget_media_title"]': currentLang === 'pt' ? 'Player de Música' : 'Ambient Player',
        '#widget-tasks span[data-i18n="widget_tasks_title"]': currentLang === 'pt' ? 'Lista de Foco' : 'Canvas Tasks',
        '#sticky-note-textarea': currentLang === 'pt' ? 'Escreva suas notas aqui...' : 'Write notes here...',
        '#media-embed-url': currentLang === 'pt' ? 'Cole o link do YouTube ou Spotify...' : 'Paste YouTube/Spotify link...',
        '#new-canvas-todo-input': currentLang === 'pt' ? 'Tarefa rápida...' : 'Quick task...',

        // Daily Notes
        '#nav-daily-notes span': currentLang === 'pt' ? 'Notas Diárias' : 'Daily Notes',
        '#page-daily-notes .subtitle': currentLang === 'pt' ? '- Notas Diárias -' : '- Daily Notes -',
        '#page-daily-notes h2[data-i18n="notes_days_title"]': currentLang === 'pt' ? 'Dias do Mês' : 'Days of Month',
        '#page-daily-notes p[data-i18n="notes_editor_subtitle"]': currentLang === 'pt' ? 'Escreva suas reflexões diárias abaixo' : 'Write your daily reflection below',
        '#page-daily-notes span[data-i18n="notes_mood_label"]': currentLang === 'pt' ? 'Humor de Hoje' : 'Today\'s Mood',
        '#page-daily-notes label[data-i18n="notes_tags_label"]': currentLang === 'pt' ? 'Tags (separadas por vírgula)' : 'Tags (comma separated)',
        '#page-daily-notes span[data-i18n="notes_save_btn"]': currentLang === 'pt' ? 'Salvar Nota' : 'Save Note',
        '#note-textarea': currentLang === 'pt' ? 'Escreva seus pensamentos, reflexões ou conquistas de hoje aqui...' : 'Write your thoughts, reflections or achievements for today here...',
        '#note-tags-input': currentLang === 'pt' ? 'ex: produtividade, treino, meditação' : 'e.g. productivity, workout, meditation'
    };

    for (const [selector, text] of Object.entries(textMap)) {
        const el = document.querySelector(selector);
        if (el) {
            if (text.includes('<')) {
                el.innerHTML = text;
            } else if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.placeholder !== undefined) {
                el.placeholder = text;
            } else {
                el.textContent = text;
            }
        }
    }

    // Set custom placeholder for dynamic inputs
    const addHabitNameInput = document.getElementById('habit-name');
    if (addHabitNameInput) {
        addHabitNameInput.placeholder = currentLang === 'pt' ? 'ex: Ler livros 📚' : 'e.g. Read books 📚';
    }

    // Translate option list elements
    const habitCategorySelects = [
        document.getElementById('habit-category'),
        document.getElementById('edit-habit-category'),
        document.getElementById('new-habit-category-inline'),
        document.querySelector('#crud-habits .crud-filters select')
    ];
    habitCategorySelects.forEach(select => {
        if (select) {
            Array.from(select.options).forEach(opt => {
                const val = opt.value;
                if (val === 'manha') opt.textContent = currentLang === 'pt' ? 'Manhã' : 'Morning';
                else if (val === 'alimentos') opt.textContent = currentLang === 'pt' ? 'Alimentos' : 'Nutrition';
                else if (val === 'higiene') opt.textContent = currentLang === 'pt' ? 'Higiene' : 'Hygiene';
                else if (val === 'tarde') opt.textContent = currentLang === 'pt' ? 'Tarde' : 'Afternoon';
                else if (val === 'projeto') opt.textContent = currentLang === 'pt' ? 'Projetos' : 'Projects';
                else if (val === 'noite') opt.textContent = currentLang === 'pt' ? 'Noite' : 'Evening';
                else if (val === 'geral') opt.textContent = currentLang === 'pt' ? 'Geral' : 'General';
            });
        }
    });

    const editTaskDaySelect = document.getElementById('edit-task-day');
    if (editTaskDaySelect) {
        const ptDays = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
        const enDays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        Array.from(editTaskDaySelect.options).forEach((opt, idx) => {
            opt.textContent = currentLang === 'pt' ? ptDays[idx] : enDays[idx];
        });
    }

    const editTaskCompletedSelect = document.getElementById('edit-task-completed');
    if (editTaskCompletedSelect) {
        Array.from(editTaskCompletedSelect.options).forEach(opt => {
            const val = opt.value;
            if (val === 'true') opt.textContent = currentLang === 'pt' ? 'Concluída' : 'Completed';
            else if (val === 'false') opt.textContent = currentLang === 'pt' ? 'Não Concluída' : 'Not Completed';
        });
    }
}

// Initialize Dashboard on Load
document.addEventListener("DOMContentLoaded", () => {
    applyTranslations();
    switchPage('habit-tracker');
    initDatePickers();
    updateMonthTitle();
    updateTaskMonthTitle();
    updateNotesMonthTitle();
    initMonthlyTrackerPicker();
    applyTheme();
    initSupabase();
    
    // Canvas Initialization
    initDraggableWidgets();
    initCanvasInteractions();
    initBackgroundPicker();
    initEditableCanvasText();
    startCanvasClock();
    loadWidgetPositions();
    loadStickyNote();
    initMediaIframe();
    loadCanvasTodos();
});

// Navigation / Page Toggling
function switchPage(pageId) {
    document.querySelectorAll('.dashboard-page').forEach(page => page.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));

    if (pageId === 'habit-tracker') {
        document.getElementById('page-habit-tracker').classList.add('active');
        document.getElementById('nav-habit-tracker').classList.add('active');
        loadHabitTrackerData();
    } else if (pageId === 'task-tracker') {
        document.getElementById('page-task-tracker').classList.add('active');
        document.getElementById('nav-task-tracker').classList.add('active');
        loadTaskTrackerData();
    } else if (pageId === 'monthly-tracker') {
        document.getElementById('page-monthly-tracker').classList.add('active');
        document.getElementById('nav-monthly-tracker').classList.add('active');
        loadMonthlyTrackerData();
    } else if (pageId === 'data-manager') {
        document.getElementById('page-data-manager').classList.add('active');
        document.getElementById('nav-data-manager').classList.add('active');
        loadCrudData();
    } else if (pageId === 'relapse-tracker') {
        document.getElementById('page-relapse-tracker').classList.add('active');
        document.getElementById('nav-relapse-tracker').classList.add('active');
        loadRelapseData();
    } else if (pageId === 'focus-canvas') {
        document.getElementById('page-focus-canvas').classList.add('active');
        document.getElementById('nav-focus-canvas').classList.add('active');
        renderCanvasTodos();
    } else if (pageId === 'daily-notes') {
        document.getElementById('page-daily-notes').classList.add('active');
        document.getElementById('nav-daily-notes').classList.add('active');
        loadDailyNotesData();
    }
}

function initDatePickers() {
    const weekInput = document.getElementById('week-start-date');
    if (weekInput) {
        weekInput.value = currentWeekStart;
        updateWeekDisplay(currentWeekStart);
    }
}

function initMonthlyTrackerPicker() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    currentMonthlyTrackerMonth = `${y}-${m}`;
    updateMonthlyTrackerTitle();
}

function updateWeekDisplay(dateStr) {
    const dateDisplay = document.getElementById('formatted-week-start');
    if (dateDisplay && dateStr) {
        const parts = dateStr.split('-');
        if (parts.length === 3) {
            dateDisplay.textContent = `${parts[2]}.${parts[1]}.${parts[0]}`;
        }
    }
}

// ==========================================
// 1. HABIT TRACKER SCRIPTS
// ==========================================

async function loadHabitTrackerData() {
    try {
        const [habitsRes, entriesRes, mentalRes] = await Promise.all([
            fetch('/api/habits').then(r => r.json()),
            fetch(`/api/habit-entries?month=${currentMonth}`).then(r => r.json()),
            fetch(`/api/mental-state?month=${currentMonth}`).then(r => r.json())
        ]);

        habits = Array.isArray(habitsRes) ? habitsRes : [];
        habitEntries = Array.isArray(entriesRes) ? entriesRes : [];
        mentalStates = Array.isArray(mentalRes) ? mentalRes : [];

        renderHabitHeaderMetrics();
        renderHabitsGrid();
        renderMentalStateGrid();
        renderHabitAnalysisList();
        renderMentalAnalysis();
        updateHabitCharts();
    } catch (err) {
        console.error("Error loading habit tracker data:", err);
    }
}

function renderHabitHeaderMetrics() {
    // Total habits count
    document.getElementById('habit-count-value').textContent = habits.length;

    // Completed habits count (for current month) - deduplicated by habitId and date
    const uniqueEntries = [];
    const seen = new Set();
    habitEntries.forEach(e => {
        const key = `${e.habitId}_${e.date}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueEntries.push(e);
        }
    });

    const completedCount = uniqueEntries.filter(e => e.completed).length;
    document.getElementById('habit-completed-value').textContent = completedCount;

    // Total possible (habits * days in current month)
    const daysInMonth = getDaysInCurrentMonth();
    const totalPossible = habits.length * daysInMonth;
    const pct = totalPossible > 0 ? Math.min(100, (completedCount / totalPossible) * 100).toFixed(2) : "0.00";
    
    document.getElementById('habit-progress-percent').textContent = `${pct}%`;
    document.getElementById('habit-progress-bar').style.width = `${pct}%`;
}

function getWeekIndexForDay(dayNum) {
    if (dayNum <= 7) return 1;
    if (dayNum <= 14) return 2;
    if (dayNum <= 21) return 3;
    if (dayNum <= 28) return 4;
    return 5;
}

function renderHabitsGrid() {
    const daysInMonth = getDaysInCurrentMonth();
    // Save focus state
    const active = document.activeElement;
    let savedRow = null;
    let savedCol = null;
    if (active && active.classList.contains('checkbox-cell')) {
        savedRow = active.getAttribute('data-row');
        savedCol = active.getAttribute('data-col');
    }

    const gridTable = document.getElementById('habit-tracker-grid');
    gridTable.innerHTML = "";

    // Generate colgroup for fixed layouts to prevent overlapping
    const colgroup = document.createElement('colgroup');
    const colTitle = document.createElement('col');
    colTitle.style.width = "150px";
    colgroup.appendChild(colTitle);
    for (let i = 1; i <= daysInMonth; i++) {
        const col = document.createElement('col');
        col.style.width = "28px";
        colgroup.appendChild(col);
    }
    // Columns for analysis
    const colBar = document.createElement('col');
    colBar.style.width = "140px";
    colgroup.appendChild(colBar);
    const colPct = document.createElement('col');
    colPct.style.width = "60px";
    colgroup.appendChild(colPct);
    gridTable.appendChild(colgroup);

    // 1. Generate Week grouping row dynamically
    const weekHeaderRow = document.createElement('tr');
    weekHeaderRow.innerHTML = `<th class="habit-title-cell"></th>`;
    
    const currentLang = localStorage.getItem('app-lang') || 'en';
    const weekSpans = [];
    let daysRemaining = daysInMonth;
    let wNum = 1;
    while (daysRemaining > 0) {
        const size = Math.min(7, daysRemaining);
        weekSpans.push({
            label: currentLang === 'pt' ? `Semana ${wNum}` : `Week ${wNum}`,
            size: size,
            class: `week-${wNum}-header`
        });
        daysRemaining -= size;
        wNum++;
    }

    weekSpans.forEach(w => {
        const th = document.createElement('th');
        th.colSpan = w.size;
        th.className = `week-header ${w.class}`;
        th.textContent = w.label;
        weekHeaderRow.appendChild(th);
    });
    // Append Analysis column header
    const thAnalysis = document.createElement('th');
    thAnalysis.colSpan = 2;
    thAnalysis.className = "week-header analysis-header-col analysis-start";
    thAnalysis.textContent = currentLang === 'pt' ? "Análise" : "Analysis";
    weekHeaderRow.appendChild(thAnalysis);
    gridTable.appendChild(weekHeaderRow);

    // 2. Generate Days letters row
    const weekdays = currentLang === 'pt' ? ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"] : ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
    const [year, month] = currentMonth.split('-').map(Number);
    const dayLettersRow = document.createElement('tr');
    dayLettersRow.innerHTML = `<th class="habit-title-cell">${currentLang === 'pt' ? 'Meus Hábitos' : 'My Habits'}</th>`;
    
    for (let day = 1; day <= daysInMonth; day++) {
        const th = document.createElement('th');
        const wIdx = getWeekIndexForDay(day);
        th.className = `week-${wIdx}-header-sub`;
        const dateObj = new Date(year, month - 1, day);
        const dayName = weekdays[dateObj.getDay()];
        th.textContent = dayName;
        dayLettersRow.appendChild(th);
    }
    // Append Analysis sub-header
    const thLettersAnalysis = document.createElement('th');
    thLettersAnalysis.colSpan = 2;
    thLettersAnalysis.className = "analysis-header-sub analysis-start";
    thLettersAnalysis.textContent = currentLang === 'pt' ? "Conclusão" : "Completion";
    dayLettersRow.appendChild(thLettersAnalysis);
    gridTable.appendChild(dayLettersRow);

    // 3. Generate Day Numbers row
    const dayNumbersRow = document.createElement('tr');
    dayNumbersRow.innerHTML = `<th class="habit-title-cell" style="background-color: var(--bg-card-header)"></th>`;
    for (let day = 1; day <= daysInMonth; day++) {
        const th = document.createElement('th');
        const wIdx = getWeekIndexForDay(day);
        th.className = `week-${wIdx}-header-sub-num`;
        th.textContent = day;
        dayNumbersRow.appendChild(th);
    }
    // Append Rate and % headers
    const thBar = document.createElement('th');
    thBar.className = "analysis-start";
    thBar.textContent = "Rate";
    dayNumbersRow.appendChild(thBar);
    const thPct = document.createElement('th');
    thPct.textContent = "%";
    dayNumbersRow.appendChild(thPct);
    gridTable.appendChild(dayNumbersRow);

    // 4. Generate Rows for each habit
    const categoriesOrder = ['manha', 'alimentos', 'higiene', 'tarde', 'projeto', 'noite', 'geral'];
    const sortedHabits = [...habits].sort((a, b) => {
        const catA = a.category || '';
        const catB = b.category || '';
        const idxA = categoriesOrder.indexOf(catA);
        const idxB = categoriesOrder.indexOf(catB);
        const valA = idxA !== -1 ? idxA : 999;
        const valB = idxB !== -1 ? idxB : 999;
        if (valA !== valB) return valA - valB;
        return a.name.localeCompare(b.name);
    });

    const categoryColors = {
        manha: "#a855f7",      // Purple
        alimentos: "#f97316",  // Orange
        higiene: "#3b82f6",    // Blue
        tarde: "#14b8a6",      // Teal
        projeto: "#22c55e",    // Green
        noite: "#ec4899",      // Pink
        geral: "#eab308"       // Yellow
    };

    sortedHabits.forEach((habit, habitIdx) => {
        const tr = document.createElement('tr');
        
        // Habit Title cell
        const titleTd = document.createElement('td');
        titleTd.className = "habit-title-cell";
        
        const catColor = categoryColors[habit.category] || "#8f9bb3";
        titleTd.style.setProperty('--cat-color', catColor);
        titleTd.title = `Category: ${habit.category || 'none'}`;
        titleTd.innerHTML = `
            <div class="habit-title-wrapper">
                <span>${habit.name}</span>
                <button class="delete-habit-inline-btn" onclick="deleteHabit('${habit._id}')" title="Delete Habit">
                    <i class="fa-regular fa-trash-can"></i>
                </button>
            </div>
        `;
        tr.appendChild(titleTd);

        // Day cells
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${currentMonth}-${String(day).padStart(2, '0')}`;
            const isCompleted = isHabitCompleted(habit._id, dateStr);
            const wIdx = getWeekIndexForDay(day);

            const td = document.createElement('td');
            td.className = `checkbox-cell week-${wIdx}-col ${isCompleted ? 'checked' : ''}`;
            td.setAttribute('tabindex', '0');
            td.setAttribute('data-row', habitIdx);
            td.setAttribute('data-col', day);
            td.setAttribute('data-habit-id', habit._id);
            td.setAttribute('data-date', dateStr);
            td.onclick = () => toggleHabitCell(habit._id, dateStr);
            
            td.innerHTML = `
                <div class="checkbox-wrapper">
                    <i class="fa-solid fa-check"></i>
                </div>
            `;
            tr.appendChild(td);
        }

        // Calculate and append habit completion analysis
        const entries = habitEntries.filter(e => e.habitId === habit._id);
        const completed = entries.filter(e => e.completed).length;
        const pct = daysInMonth > 0 ? ((completed / daysInMonth) * 100).toFixed(2) : "0.00";

        const tdBar = document.createElement('td');
        tdBar.className = "analysis-cell-bar analysis-start";
        tdBar.innerHTML = `
            <div class="analysis-item-bar" style="margin: 0;">
                <div class="analysis-item-fill" style="width: ${pct}%; height: 100%;"></div>
            </div>
        `;
        tr.appendChild(tdBar);

        const tdPct = document.createElement('td');
        tdPct.className = "analysis-cell-pct";
        tdPct.textContent = `${pct}%`;
        tr.appendChild(tdPct);

        gridTable.appendChild(tr);
    });

    // 5. Generate daily stats summary rows
    const progressRow = document.createElement('tr');
    progressRow.className = "summary-row";
    progressRow.innerHTML = `<td class="habit-title-cell">Progress</td>`;

    const doneRow = document.createElement('tr');
    doneRow.className = "summary-row";
    doneRow.innerHTML = `<td class="habit-title-cell">Done</td>`;

    const notDoneRow = document.createElement('tr');
    notDoneRow.className = "summary-row";
    notDoneRow.innerHTML = `<td class="habit-title-cell">Not Done</td>`;

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${currentMonth}-${String(day).padStart(2, '0')}`;
        
        // Count entries for this day
        const dayEntries = habitEntries.filter(e => e.date === dateStr);
        // Deduplicate dayEntries by habitId
        const uniqueDayCompleted = new Set();
        dayEntries.forEach(e => {
            if (e.completed) {
                uniqueDayCompleted.add(e.habitId);
            }
        });
        const done = uniqueDayCompleted.size;
        const total = habits.length;
        const notDone = Math.max(0, total - done);
        const progressPct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

        const tdProg = document.createElement('td');
        tdProg.textContent = `${progressPct}%`;
        progressRow.appendChild(tdProg);

        const tdDone = document.createElement('td');
        tdDone.textContent = done;
        doneRow.appendChild(tdDone);

        const tdNot = document.createElement('td');
        tdNot.textContent = notDone;
        notDoneRow.appendChild(tdNot);
    }
    // Append spacer cells for daily summary rows
    const tdProgSpacer = document.createElement('td');
    tdProgSpacer.className = "analysis-start";
    progressRow.appendChild(tdProgSpacer);
    progressRow.appendChild(document.createElement('td'));

    const tdDoneSpacer = document.createElement('td');
    tdDoneSpacer.className = "analysis-start";
    doneRow.appendChild(tdDoneSpacer);
    doneRow.appendChild(document.createElement('td'));

    const tdNotSpacer = document.createElement('td');
    tdNotSpacer.className = "analysis-start";
    notDoneRow.appendChild(tdNotSpacer);
    notDoneRow.appendChild(document.createElement('td'));

    gridTable.appendChild(progressRow);
    gridTable.appendChild(doneRow);
    gridTable.appendChild(notDoneRow);

    // Restore focus state
    if (savedRow !== null && savedCol !== null) {
        const cellToFocus = document.querySelector(`.checkbox-cell[data-row="${savedRow}"][data-col="${savedCol}"]`);
        if (cellToFocus) {
            cellToFocus.focus();
        }
    }
}

function isHabitCompleted(habitId, dateStr) {
    const entry = habitEntries.find(e => e.habitId === habitId && e.date === dateStr);
    return entry ? entry.completed : false;
}

async function toggleHabitCell(habitId, dateStr) {
    try {
        const res = await fetch('/api/habit-entries/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ habitId, date: dateStr })
        }).then(r => r.json());

        if (res.success) {
            // Find and update local entry state
            const entryIndex = habitEntries.findIndex(e => e.habitId === habitId && e.date === dateStr);
            if (entryIndex !== -1) {
                habitEntries[entryIndex].completed = res.completed;
            } else {
                habitEntries.push({ habitId, date: dateStr, completed: res.completed });
            }

            renderHabitHeaderMetrics();
            renderHabitsGrid();
            renderHabitAnalysisList();
            renderMentalAnalysis();
            updateHabitCharts();
        }
    } catch (err) {
        console.error("Error toggling habit:", err);
    }
}

function renderMentalStateGrid() {
    const daysInMonth = getDaysInCurrentMonth();
    const gridTable = document.getElementById('mental-state-grid');
    gridTable.innerHTML = "";

    // Generate colgroup for fixed layouts to prevent overlapping
    const colgroup = document.createElement('colgroup');
    const colTitle = document.createElement('col');
    colTitle.style.width = "150px";
    colgroup.appendChild(colTitle);
    for (let i = 1; i <= daysInMonth; i++) {
        const col = document.createElement('col');
        col.style.width = "28px";
        colgroup.appendChild(col);
    }
    gridTable.appendChild(colgroup);

    // 1. Group Headers dynamically
    const weekHeaderRow = document.createElement('tr');
    weekHeaderRow.innerHTML = `<th class="habit-title-cell"></th>`;
    
    const weekSpans = [];
    let daysRemaining = daysInMonth;
    const currentLang = localStorage.getItem('app-lang') || 'en';
    let wNum = 1;
    while (daysRemaining > 0) {
        const size = Math.min(7, daysRemaining);
        weekSpans.push({
            label: currentLang === 'pt' ? `Semana ${wNum}` : `Week ${wNum}`,
            size: size,
            class: `week-${wNum}-header`
        });
        daysRemaining -= size;
        wNum++;
    }

    weekSpans.forEach(w => {
        const th = document.createElement('th');
        th.colSpan = w.size;
        th.className = `week-header ${w.class}`;
        th.textContent = w.label;
        weekHeaderRow.appendChild(th);
    });
    gridTable.appendChild(weekHeaderRow);

    // 2. Day letters row dynamically
    const weekdays = currentLang === 'pt' ? ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"] : ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
    const [year, month] = currentMonth.split('-').map(Number);
    const dayLettersRow = document.createElement('tr');
    dayLettersRow.innerHTML = `<th class="habit-title-cell">${currentLang === 'pt' ? 'Estado Mental' : 'Mental State'}</th>`;
    
    for (let day = 1; day <= daysInMonth; day++) {
        const th = document.createElement('th');
        const wIdx = getWeekIndexForDay(day);
        th.className = `week-${wIdx}-header-sub`;
        const dateObj = new Date(year, month - 1, day);
        const dayName = weekdays[dateObj.getDay()];
        th.textContent = dayName;
        dayLettersRow.appendChild(th);
    }
    gridTable.appendChild(dayLettersRow);

    // 3. Day numbers row
    const dayNumbersRow = document.createElement('tr');
    dayNumbersRow.innerHTML = `<th class="habit-title-cell" style="background-color: var(--bg-card-header)"></th>`;
    for (let day = 1; day <= daysInMonth; day++) {
        const th = document.createElement('th');
        th.textContent = day;
        dayNumbersRow.appendChild(th);
    }
    gridTable.appendChild(dayNumbersRow);

    // Generate Rows: Mood, Motivation, Score
    const rows = [
        { label: "Mood", key: "mood" },
        { label: "Motivation", key: "motivation" },
        { label: "Score", key: "score" }
    ];

    rows.forEach(row => {
        const tr = document.createElement('tr');
        const titleTd = document.createElement('td');
        titleTd.className = "habit-title-cell";
        titleTd.textContent = row.label;
        tr.appendChild(titleTd);

        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${currentMonth}-${String(day).padStart(2, '0')}`;
            const state = mentalStates.find(s => s.date === dateStr) || { mood: 0, motivation: 0 };
            
            const td = document.createElement('td');
            td.className = "mental-cell";
            
            if (row.key === 'score') {
                const avg = (state.mood + state.motivation) / 2;
                const scorePercent = avg > 0 ? Math.round(avg * 10) : 0;
                td.textContent = scorePercent > 0 ? `${scorePercent}%` : "-";
                td.id = `mental-score-${dateStr}`;
                
                // Color classes
                if (scorePercent >= 75) td.className += " mental-val-high";
                else if (scorePercent >= 50) td.className += " mental-val-mid";
                else if (scorePercent > 0) td.className += " mental-val-low";
            } else {
                const val = state[row.key];
                const colorClass = getMentalColorClass(val);
                td.className = "mental-cell has-select";
                
                td.innerHTML = `
                    <input type="number" 
                           class="${colorClass}" 
                           min="1" 
                           max="10" 
                           list="mental-options"
                           value="${val > 0 ? val : ''}" 
                           data-date="${dateStr}" 
                           data-key="${row.key}"
                           onchange="saveMentalValue('${dateStr}', '${row.key}', this.value); updateInputColor(this)"
                           oninput="updateInputColor(this)">
                `;
            }
            tr.appendChild(td);
        }
        gridTable.appendChild(tr);
    });
}

function getMentalColorClass(val) {
    if (val >= 8) return "mental-val-high";
    if (val >= 5) return "mental-val-mid";
    if (val > 0) return "mental-val-low";
    return "";
}

function updateInputColor(input) {
    const val = parseInt(input.value, 10);
    input.classList.remove('mental-val-high', 'mental-val-mid', 'mental-val-low');
    const colorClass = getMentalColorClass(val);
    if (colorClass) {
        input.classList.add(colorClass);
    }
}

async function saveMentalValue(dateStr, key, value) {
    let state = mentalStates.find(s => s.date === dateStr);
    if (!state) {
        state = { date: dateStr, mood: 0, motivation: 0 };
    }
    
    let parsedVal = parseInt(value, 10);
    if (isNaN(parsedVal) || parsedVal < 1 || parsedVal > 10) {
        parsedVal = 0;
    }
    
    state[key] = parsedVal;
    
    try {
        const res = await fetch('/api/mental-state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                date: dateStr,
                mood: state.mood,
                motivation: state.motivation
            })
        }).then(r => r.json());
        
        if (res.success) {
            const idx = mentalStates.findIndex(s => s.date === dateStr);
            if (idx === -1) {
                mentalStates.push(state);
            } else {
                mentalStates[idx] = state;
            }
            
            updateScoreCell(dateStr);
            renderMentalAnalysis();
            updateHabitCharts();
        }
    } catch (err) {
        console.error("Error saving mental value:", err);
    }
}

function updateScoreCell(dateStr) {
    const state = mentalStates.find(s => s.date === dateStr) || { mood: 0, motivation: 0 };
    const td = document.getElementById(`mental-score-${dateStr}`);
    if (td) {
        const avg = (state.mood + state.motivation) / 2;
        const scorePercent = avg > 0 ? Math.round(avg * 10) : 0;
        td.textContent = scorePercent > 0 ? `${scorePercent}%` : "-";
        
        td.className = "mental-cell";
        if (scorePercent >= 75) td.className += " mental-val-high";
        else if (scorePercent >= 50) td.className += " mental-val-mid";
        else if (scorePercent > 0) td.className += " mental-val-low";
    }
}

function renderHabitAnalysisList() {
    // No-op: Habit progress analysis is now rendered directly inside the grid table rows.
}

function renderMentalAnalysis() {
    const weeklyList = document.getElementById('weekly-mindset-list');
    weeklyList.innerHTML = "";

    const daysInMonth = getDaysInCurrentMonth();
    const weekRanges = [];
    let start = 1;
    let weekNum = 1;
    while (start <= daysInMonth) {
        let end = Math.min(start + 6, daysInMonth);
        weekRanges.push({
            name: `Week ${weekNum}`,
            start: start,
            end: end,
            color: `var(--week${weekNum})`
        });
        start += 7;
        weekNum++;
    }

    // 1. Mood group
    const moodGroup = document.createElement('div');
    moodGroup.className = "analysis-group";
    moodGroup.innerHTML = `<h4 class="analysis-group-title" style="color: #3b82f6; font-size: 11px; font-weight: 600; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.5px;">Mood</h4>`;
    
    const moodContainer = document.createElement('div');
    moodContainer.className = "analysis-list";
    moodGroup.appendChild(moodContainer);

    // 2. Motivation group
    const motivGroup = document.createElement('div');
    motivGroup.className = "analysis-group";
    motivGroup.style.marginTop = "16px";
    motivGroup.innerHTML = `<h4 class="analysis-group-title" style="color: #10b981; font-size: 11px; font-weight: 600; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.5px;">Motivation</h4>`;
    
    const motivContainer = document.createElement('div');
    motivContainer.className = "analysis-list";
    motivGroup.appendChild(motivContainer);

    weekRanges.forEach(range => {
        let totalMood = 0;
        let totalMotiv = 0;
        let countMood = 0;
        let countMotiv = 0;

        for (let d = range.start; d <= range.end; d++) {
            const dateStr = `${currentMonth}-${String(d).padStart(2, '0')}`;
            const state = mentalStates.find(s => s.date === dateStr);
            if (state) {
                if (state.mood > 0) {
                    totalMood += state.mood;
                    countMood++;
                }
                if (state.motivation > 0) {
                    totalMotiv += state.motivation;
                    countMotiv++;
                }
            }
        }

        const avgMood = countMood > 0 ? totalMood / countMood : 0;
        const moodPct = (avgMood * 10).toFixed(2);

        const avgMotiv = countMotiv > 0 ? totalMotiv / countMotiv : 0;
        const motivPct = (avgMotiv * 10).toFixed(2);

        // Mood row
        const moodItem = document.createElement('div');
        moodItem.className = "analysis-item";
        moodItem.innerHTML = `
            <span class="analysis-item-name">${range.name}</span>
            <div class="analysis-item-bar">
                <div class="analysis-item-fill" style="width: ${moodPct}%; background-color: #3b82f6;"></div>
            </div>
            <span class="analysis-item-pct">${countMood > 0 ? moodPct + '%' : '-'}</span>
        `;
        moodContainer.appendChild(moodItem);

        // Motivation row
        const motivItem = document.createElement('div');
        motivItem.className = "analysis-item";
        motivItem.innerHTML = `
            <span class="analysis-item-name">${range.name}</span>
            <div class="analysis-item-bar">
                <div class="analysis-item-fill" style="width: ${motivPct}%; background-color: #10b981;"></div>
            </div>
            <span class="analysis-item-pct">${countMotiv > 0 ? motivPct + '%' : '-'}</span>
        `;
        motivContainer.appendChild(motivItem);
    });

    weeklyList.appendChild(moodGroup);
    weeklyList.appendChild(motivGroup);
}

function updateHabitCharts() {
    const daysInMonth = getDaysInCurrentMonth();
    
    // Reset chart container and card styles to their original responsive layout
    const habitChartContainer = document.getElementById('habitTrendChart').parentElement;
    if (habitChartContainer) {
        habitChartContainer.style.width = '';
        habitChartContainer.style.minWidth = '';
    }
    
    const habitChartCard = document.querySelector('.chart-card');
    if (habitChartCard) {
        habitChartCard.style.overflowX = '';
    }

    const habitCtx = document.getElementById('habitTrendChart').getContext('2d');
    const labels = Array.from({ length: daysInMonth }, (_, i) => String(i + 1));
    
    // Calculate the single daily completion rate (percentage of habits completed)
    const dailyCompletionData = labels.map(day => {
        const dateStr = `${currentMonth}-${day.padStart(2, '0')}`;
        const dayEntries = habitEntries.filter(e => e.date === dateStr);
        // Deduplicate entries by habitId to prevent progress from exceeding 100%
        const uniqueDayCompleted = new Set();
        dayEntries.forEach(e => {
            if (e.completed) {
                uniqueDayCompleted.add(e.habitId);
            }
        });
        const done = uniqueDayCompleted.size;
        const pct = habits.length > 0 ? Math.round((done / habits.length) * 100) : 0;
        return Math.min(100, pct);
    });

    const dataset = [{
        label: 'Habit Progress %',
        data: dailyCompletionData,
        borderColor: '#14b8a6',
        borderWidth: 2,
        backgroundColor: 'rgba(20, 184, 166, 0.05)',
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 4
    }];

    if (habitTrendChartInstance) {
        habitTrendChartInstance.data.labels = labels;
        habitTrendChartInstance.data.datasets = dataset;
        habitTrendChartInstance.options.layout = { padding: {} };
        if (habitTrendChartInstance.options.scales.y) {
            habitTrendChartInstance.options.scales.y.afterFit = undefined;
        }
        if (habitTrendChartInstance.options.scales.x) {
            habitTrendChartInstance.options.scales.x.offset = false;
        }
        if (habitTrendChartInstance.options.plugins && habitTrendChartInstance.options.plugins.legend) {
            habitTrendChartInstance.options.plugins.legend.display = false;
        }
        habitTrendChartInstance.update();
    } else {
        habitTrendChartInstance = new Chart(habitCtx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: dataset
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: {
                        min: 0,
                        max: 100,
                        grid: { color: 'rgba(255, 255, 255, 0.03)' },
                        ticks: { color: '#5e6b85', font: { size: 9 }, callback: value => value + '%' }
                    },
                    x: {
                        grid: { display: false },
                        ticks: { color: '#5e6b85', font: { size: 9 } }
                    }
                }
            }
        });
    }

    // 2. Mental State Trend Chart (Mood & Motivation daily overlays)
    const mentalCtx = document.getElementById('mentalTrendChart').getContext('2d');
    
    // Determine custom range: from first logged day of the month up to current day (if current month) or end of month (if past month)
    const now = new Date();
    const todayYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    
    const loggedDays = mentalStates
        .filter(s => s.date.startsWith(currentMonth))
        .map(s => parseInt(s.date.split('-')[2], 10))
        .sort((a, b) => a - b);
        
    let startDay = 1;
    if (loggedDays.length > 0) {
        startDay = loggedDays[0];
    }
    
    let endDay = daysInMonth;
    if (currentMonth === todayYearMonth) {
        endDay = now.getDate();
    }
    
    if (endDay < startDay) {
        endDay = startDay;
    }
    
    const mentalLabels = [];
    for (let d = startDay; d <= endDay; d++) {
        mentalLabels.push(String(d));
    }
    
    const moodData = mentalLabels.map(day => {
        const dateStr = `${currentMonth}-${day.padStart(2, '0')}`;
        const state = mentalStates.find(s => s.date === dateStr);
        return state ? state.mood : null;
    });

    const motivationData = mentalLabels.map(day => {
        const dateStr = `${currentMonth}-${day.padStart(2, '0')}`;
        const state = mentalStates.find(s => s.date === dateStr);
        return state ? state.motivation : null;
    });

    if (mentalTrendChartInstance) {
        mentalTrendChartInstance.data.labels = mentalLabels;
        mentalTrendChartInstance.data.datasets[0].data = moodData;
        mentalTrendChartInstance.data.datasets[1].data = motivationData;
        mentalTrendChartInstance.update();
    } else {
        mentalTrendChartInstance = new Chart(mentalCtx, {
            type: 'line',
            data: {
                labels: mentalLabels,
                datasets: [
                    {
                        label: 'Mood',
                        data: moodData,
                        borderColor: '#3b82f6',
                        borderWidth: 2,
                        backgroundColor: 'transparent',
                        tension: 0.35,
                        pointRadius: 0,
                        pointHoverRadius: 4
                    },
                    {
                        label: 'Motivation',
                        data: motivationData,
                        borderColor: '#10b981',
                        borderWidth: 2,
                        backgroundColor: 'transparent',
                        tension: 0.35,
                        pointRadius: 0,
                        pointHoverRadius: 4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: {
                        labels: { color: '#8f9bb3', font: { size: 10 } }
                    }
                },
                scales: {
                    y: {
                        min: 0,
                        max: 10,
                        grid: { color: 'rgba(255, 255, 255, 0.03)' },
                        ticks: { color: '#5e6b85', font: { size: 9 } }
                    },
                    x: {
                        grid: { display: false },
                        ticks: { color: '#5e6b85', font: { size: 9 } }
                    }
                }
            }
        });
    }

    // 3. Mindset Variables Chart (Right column bar averages)
    const variablesCtx = document.getElementById('mindsetVariablesChart').getContext('2d');
    
    let sumMood = 0, countMood = 0;
    let sumMotiv = 0, countMotiv = 0;

    mentalStates.forEach(s => {
        if (s.mood > 0) { sumMood += s.mood; countMood++; }
        if (s.motivation > 0) { sumMotiv += s.motivation; countMotiv++; }
    });

    const avgMood = countMood > 0 ? (sumMood / countMood).toFixed(1) : 0;
    const avgMotiv = countMotiv > 0 ? (sumMotiv / countMotiv).toFixed(1) : 0;

    if (mindsetVariablesChartInstance) {
        mindsetVariablesChartInstance.destroy();
    }

    mindsetVariablesChartInstance = new Chart(variablesCtx, {
        type: 'bar',
        data: {
            labels: ['Mood', 'Motivation'],
            datasets: [{
                data: [avgMood, avgMotiv],
                backgroundColor: ['#3b82f6', '#ec4899'],
                borderRadius: 0,
                barThickness: 16
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: {
                    min: 0,
                    max: 10,
                    grid: { color: 'rgba(255, 255, 255, 0.03)' },
                    ticks: { color: '#5e6b85', font: { size: 9 } }
                },
                y: {
                    grid: { display: false },
                    ticks: { color: '#8f9bb3', font: { size: 10 } }
                }
            }
        }
    });
}

// Modal actions - Habits & Mental
function openAddHabitModal() {
    document.getElementById('add-habit-modal').classList.add('active');
}

function closeAddHabitModal() {
    document.getElementById('add-habit-modal').classList.remove('active');
    document.getElementById('add-habit-form').reset();
}

async function submitAddHabit(e) {
    e.preventDefault();
    const name = document.getElementById('habit-name').value;
    const category = document.getElementById('habit-category').value;

    try {
        const res = await fetch('/api/habits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, category })
        }).then(r => r.json());

        if (res._id) {
            closeAddHabitModal();
            loadHabitTrackerData();
        }
    } catch (err) {
        console.error("Error adding habit:", err);
    }
}

async function deleteHabit(habitId) {
    const currentLang = localStorage.getItem('app-lang') || 'en';
    if (!confirm(translations[currentLang].confirm_delete_habit)) return;
    try {
        const res = await fetch(`/api/habits/${habitId}`, { method: 'DELETE' }).then(r => r.json());
        if (res.success) {
            loadHabitTrackerData();
        }
    } catch (err) {
        console.error("Error deleting habit:", err);
    }
}

function openEditMentalModal(dateStr, currentMood, currentMotiv) {
    document.getElementById('edit-mental-date').value = dateStr;
    document.getElementById('edit-mental-mood').value = currentMood || 5;
    document.getElementById('edit-mental-motivation').value = currentMotiv || 5;
    document.getElementById('edit-mental-title').textContent = `Mental State - Jan ${dateStr.split('-')[2]}`;
    document.getElementById('edit-mental-modal').classList.add('active');
}

function closeEditMentalModal() {
    document.getElementById('edit-mental-modal').classList.remove('active');
}

async function submitEditMental(e) {
    e.preventDefault();
    const date = document.getElementById('edit-mental-date').value;
    const mood = document.getElementById('edit-mental-mood').value;
    const motivation = document.getElementById('edit-mental-motivation').value;

    try {
        const res = await fetch('/api/mental-state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, mood, motivation })
        }).then(r => r.json());

        if (res.success) {
            closeEditMentalModal();
            loadHabitTrackerData();
        }
    } catch (err) {
        console.error("Error updating mental state:", err);
    }
}


// ==========================================
// 2. TASK TRACKER SCRIPTS
// ==========================================

async function loadTaskTrackerData() {
    const picker = document.getElementById('week-start-date');
    if (picker) {
        currentWeekStart = picker.value;
        updateWeekDisplay(currentWeekStart);
    }

    try {
        const [tasksRes, mindsetRes, mentalRes] = await Promise.all([
            fetch(`/api/tasks?weekStartDate=${currentWeekStart}`).then(r => r.json()),
            fetch(`/api/mindset-tracker?weekStartDate=${currentWeekStart}`).then(r => r.json()),
            fetch('/api/mental-state').then(r => r.json())
        ]);

        weeklyTasks = Array.isArray(tasksRes) ? tasksRes : [];
        weeklyMindset = Array.isArray(mindsetRes) ? mindsetRes : [];
        mentalStates = Array.isArray(mentalRes) ? mentalRes : [];

        renderWeeklyColumns();
        updateTaskCharts();
    } catch (err) {
        console.error("Error loading task tracker data:", err);
    }
}

function getWeekDates(startDateStr) {
    const dates = [];
    const baseDate = new Date(startDateStr + 'T00:00:00');
    
    for (let i = 0; i < 7; i++) {
        const d = new Date(baseDate);
        d.setDate(baseDate.getDate() + i);
        
        // Format YYYY-MM-DD
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        dates.push({
            dateStr: `${y}-${m}-${day}`,
            displayStr: `${day}.${m}.${y}`
        });
    }
    return dates;
}

function renderWeeklyColumns() {
    // Capture scroll positions
    const windowScrollTop = window.scrollY || document.documentElement.scrollTop;
    const taskScrolls = {};
    document.querySelectorAll('.day-column').forEach((col, idx) => {
        const taskSection = col.querySelector('.column-tasks-section');
        if (taskSection) {
            taskScrolls[idx] = taskSection.scrollTop;
        }
    });

    // Capture previous completion percentages
    const prevPercentages = {};
    for (let i = 0; i < 7; i++) {
        const textEl = document.querySelector(`.day-theme-${i} .day-gauge-text`);
        if (textEl) {
            prevPercentages[i] = parseInt(textEl.textContent, 10) || 0;
        } else {
            prevPercentages[i] = 0;
        }
    }

    const grid = document.getElementById('weekly-days-grid');
    grid.innerHTML = "";

    const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const colors = ["#a855f7", "#3b82f6", "#14b8a6", "#22c55e", "#84cc16", "#eab308", "#f97316"];
    
    const weekDates = getWeekDates(currentWeekStart);

    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
        const dayName = weekdays[dayIdx];
        const dayColor = colors[dayIdx];
        const dayDate = weekDates[dayIdx];

        const dayTasks = weeklyTasks.filter(t => t.dayOfWeek === dayIdx);
        const completed = dayTasks.filter(t => t.completed).length;
        const total = dayTasks.length;
        const uncompleted = Math.max(0, total - completed);
        const completionPct = total > 0 ? Math.round((completed / total) * 100) : 0;

        // Circular Gauge calculations (SVG path parameters)
        const radius = 25;
        const circ = 2 * Math.PI * radius; // 157.08
        
        // Initial offset uses the captured previous percentage so it transitions from it!
        const prevPct = prevPercentages[dayIdx] !== undefined ? prevPercentages[dayIdx] : 0;
        const initialOffset = circ - (prevPct / 100) * circ;

        // Day container
        const column = document.createElement('div');
        column.className = `day-column day-theme-${dayIdx}`;
        column.innerHTML = `
            <div class="day-column-header">
                <span class="day-title" style="color: ${dayColor};">${dayName}</span>
                <div class="day-date">${dayDate.displayStr}</div>
                
                <!-- Circular gauge -->
                <div class="day-gauge-wrapper" onclick="openDayMindsetModal(${dayIdx})" title="Click to track mindset!">
                    <svg viewBox="0 0 60 60" style="width: 100%; height: 100%; transform: rotate(-90deg);">
                        <circle cx="30" cy="30" r="${radius}" fill="none" stroke="rgba(255,255,255,0.03)" stroke-width="5"></circle>
                        <circle id="gauge-circle-${dayIdx}" cx="30" cy="30" r="${radius}" fill="none" stroke="${dayColor}" stroke-width="6"
                                stroke-dasharray="${circ}" stroke-dashoffset="${initialOffset}" stroke-linecap="round"
                                style="transition: stroke-dashoffset 0.6s cubic-bezier(0.4, 0, 0.2, 1);"></circle>
                    </svg>
                    <span class="day-gauge-text">${completionPct}%</span>
                </div>
            </div>

            <!-- Tasks list section -->
            <div class="column-tasks-section">
                <span class="tasks-title">Tasks</span>
                <div class="tasks-list-items" id="tasks-list-day-${dayIdx}">
                    <!-- Loaded dynamically -->
                </div>
            </div>

            <!-- Quick Add form -->
            <form class="add-task-form" onsubmit="submitAddTask(event, ${dayIdx}, '${dayColor}')">
                <input type="text" class="add-task-input" placeholder="+ Add task..." required>
            </form>

            <!-- Column footer counts -->
            <div class="column-footer">
                <span>
                    <span class="completed-lbl">Completed</span>
                    <span class="completed-val" style="color: #ffffff;">${completed}</span>
                </span>
                <span>
                    <span class="completed-lbl">Not Completed</span>
                    <span class="completed-val" style="color: #ffffff;">${uncompleted}</span>
                </span>
            </div>
        `;

        grid.appendChild(column);

        // Populate tasks list
        const itemsContainer = column.querySelector(`#tasks-list-day-${dayIdx}`);
        dayTasks.forEach(task => {
            const taskDiv = document.createElement('div');
            taskDiv.className = `task-item day-${dayIdx} ${task.completed ? 'checked' : ''}`;
            taskDiv.onclick = (e) => {
                // Ignore clicks on deletion button
                if (e.target.closest('.delete-task-btn')) return;
                toggleTask(task._id, task.completed);
            };

            taskDiv.innerHTML = `
                <div class="task-checkbox">
                    <i class="fa-solid fa-check"></i>
                </div>
                <span class="task-text">${task.text}</span>
                <button class="delete-task-btn" onclick="deleteTask('${task._id}')" title="Delete Task">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            `;
            itemsContainer.appendChild(taskDiv);
        });
    }

    // Restore scroll positions
    window.scrollTo(0, windowScrollTop);
    document.querySelectorAll('.day-column').forEach((col, idx) => {
        const taskSection = col.querySelector('.column-tasks-section');
        if (taskSection && taskScrolls[idx] !== undefined) {
            taskSection.scrollTop = taskScrolls[idx];
        }
    });

    // Animate custom SVG gauges to their new target offsets in the next frame
    requestAnimationFrame(() => {
        setTimeout(() => {
            for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
                const dayTasks = weeklyTasks.filter(t => t.dayOfWeek === dayIdx);
                const completed = dayTasks.filter(t => t.completed).length;
                const total = dayTasks.length;
                const completionPct = total > 0 ? Math.round((completed / total) * 100) : 0;
                
                const radius = 25;
                const circ = 2 * Math.PI * radius;
                const targetOffset = circ - (completionPct / 100) * circ;
                
                const circle = document.getElementById(`gauge-circle-${dayIdx}`);
                if (circle) {
                    circle.style.strokeDashoffset = targetOffset;
                }
            }
        }, 50);
    });
}

async function toggleTask(taskId, currentStatus) {
    try {
        const res = await fetch(`/api/tasks/${taskId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ completed: !currentStatus })
        }).then(r => r.json());

        if (res.success) {
            loadTaskTrackerData();
        }
    } catch (err) {
        console.error("Error toggling task:", err);
    }
}

async function submitAddTask(e, dayIdx, dayColor) {
    e.preventDefault();
    const input = e.target.querySelector('.add-task-input');
    const text = input.value.trim();
    if (!text) return;

    try {
        const res = await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                weekStartDate: currentWeekStart,
                dayOfWeek: dayIdx,
                text: text,
                color: dayColor
            })
        }).then(r => r.json());

        if (res._id) {
            input.value = "";
            loadTaskTrackerData();
        }
    } catch (err) {
        console.error("Error adding task:", err);
    }
}

async function deleteTask(taskId) {
    try {
        const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' }).then(r => r.json());
        if (res.success) {
            loadTaskTrackerData();
        }
    } catch (err) {
        console.error("Error deleting task:", err);
    }
}

function updateTaskCharts() {
    // 1. Overall Header Progress Radial Gauge & Bar chart
    const totalTasks = weeklyTasks.length;
    const completedTasks = weeklyTasks.filter(t => t.completed).length;
    const overallPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    // Update Header Radial Gauge
    const gaugeFill = document.getElementById('weekly-gauge-fill');
    if (gaugeFill) {
        // Radius of circle in header SVG is 40. Circ = 2 * PI * 40 = 251.2
        const circ = 251.2;
        const offset = circ - (overallPct / 100) * circ;
        gaugeFill.style.strokeDashoffset = offset;
    }
    document.getElementById('weekly-gauge-percent').textContent = `${overallPct}%`;
    document.getElementById('weekly-gauge-fraction').textContent = `${completedTasks} / ${totalTasks} Completed`;

    // 2. Bar Chart (Daily completion stats)
    const barCtx = document.getElementById('weeklyProgressBars').getContext('2d');
    const daysArr = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const colors = ["#a855f7", "#3b82f6", "#14b8a6", "#22c55e", "#84cc16", "#eab308", "#f97316"];

    const dailyCompleted = daysArr.map((_, i) => {
        return weeklyTasks.filter(t => t.dayOfWeek === i && t.completed).length;
    });

    const dailyUncompleted = daysArr.map((_, i) => {
        const total = weeklyTasks.filter(t => t.dayOfWeek === i).length;
        const completed = weeklyTasks.filter(t => t.dayOfWeek === i && t.completed).length;
        return Math.max(0, total - completed);
    });

    if (weeklyProgressBarsInstance) {
        weeklyProgressBarsInstance.data.labels = daysArr;
        weeklyProgressBarsInstance.data.datasets[0].data = dailyCompleted;
        weeklyProgressBarsInstance.data.datasets[1].data = dailyUncompleted;
        weeklyProgressBarsInstance.update();
    } else {
        weeklyProgressBarsInstance = new Chart(barCtx, {
            type: 'bar',
            data: {
                labels: daysArr,
                datasets: [
                    {
                        label: 'Completed',
                        data: dailyCompleted,
                        backgroundColor: colors,
                        borderRadius: 0,
                        barThickness: 14
                    },
                    {
                        label: 'Remaining',
                        data: dailyUncompleted,
                        backgroundColor: 'rgba(255, 255, 255, 0.06)',
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1,
                        borderRadius: 0,
                        barThickness: 14
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const dayIndex = context.dataIndex;
                                const completed = dailyCompleted[dayIndex];
                                const uncompleted = dailyUncompleted[dayIndex];
                                const total = completed + uncompleted;
                                if (context.datasetIndex === 0) {
                                    return `Completed: ${completed} / ${total}`;
                                } else {
                                    return `Remaining: ${uncompleted} / ${total}`;
                                }
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        stacked: true,
                        min: 0,
                        grid: { color: 'rgba(255, 255, 255, 0.03)' },
                        ticks: { color: '#5e6b85', font: { size: 9 }, stepSize: 1 }
                    },
                    x: {
                        stacked: true,
                        grid: { display: false },
                        ticks: { color: '#8f9bb3', font: { size: 9 } }
                    }
                }
            }
        });
    }

    // 3. Weekly Mindset Line Chart
    const lineCtx = document.getElementById('weeklyMindsetChart').getContext('2d');
    
    const energyData = [];
    const focusData = [];
    const motivationData = [];
    const weekDates = getWeekDates(currentWeekStart);

    for (let day = 0; day < 7; day++) {
        const ms = weeklyMindset.find(m => m.dayOfWeek === day);
        const dateStr = weekDates[day].dateStr;
        const mentalEntry = mentalStates.find(s => s.date === dateStr);
        
        let energyValue = null;
        let focusValue = null;
        let motivationValue = null;

        if (mentalEntry) {
            focusValue = mentalEntry.mood !== undefined ? mentalEntry.mood : 0;
            motivationValue = mentalEntry.motivation !== undefined ? mentalEntry.motivation : 0;
            energyValue = (focusValue + motivationValue) / 2;
        } else if (ms) {
            focusValue = ms.focus !== undefined ? ms.focus : 0;
            motivationValue = ms.motivation !== undefined ? ms.motivation : 0;
            energyValue = ms.energy !== undefined ? ms.energy : (focusValue + motivationValue) / 2;
        }

        energyData.push(energyValue);
        focusData.push(focusValue);
        motivationData.push(motivationValue);
    }

    if (weeklyMindsetChartInstance) {
        weeklyMindsetChartInstance.data.labels = daysArr;
        weeklyMindsetChartInstance.data.datasets[0].data = energyData;
        weeklyMindsetChartInstance.data.datasets[1].data = focusData;
        weeklyMindsetChartInstance.data.datasets[2].data = motivationData;
        weeklyMindsetChartInstance.update();
    } else {
        weeklyMindsetChartInstance = new Chart(lineCtx, {
            type: 'line',
            data: {
                labels: daysArr,
                datasets: [
                    {
                        label: 'Energy',
                        data: energyData,
                        borderColor: '#f43f5e',
                        borderWidth: 2,
                        backgroundColor: 'transparent',
                        tension: 0.35,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        spanGaps: true
                    },
                    {
                        label: 'Focus',
                        data: focusData,
                        borderColor: '#3b82f6',
                        borderWidth: 2,
                        backgroundColor: 'transparent',
                        tension: 0.35,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        spanGaps: true
                    },
                    {
                        label: 'Motivation',
                        data: motivationData,
                        borderColor: '#10b981',
                        borderWidth: 2,
                        backgroundColor: 'transparent',
                        tension: 0.35,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        spanGaps: true
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: { legend: { display: false } },
                scales: {
                    y: {
                        min: 0,
                        max: 10,
                        grid: { color: 'rgba(255, 255, 255, 0.03)' },
                        ticks: { color: '#5e6b85', font: { size: 9 } }
                    },
                    x: {
                        grid: { display: false },
                        ticks: { color: '#8f9bb3', font: { size: 9 } }
                    }
                }
            }
        });
    }
}

function openDayMindsetModal(dayIdx) {
    const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const ms = weeklyMindset.find(m => m.dayOfWeek === dayIdx) || { energy: 5, focus: 5, motivation: 5 };

    const weekDates = getWeekDates(currentWeekStart);
    const dateStr = weekDates[dayIdx].dateStr;
    const mentalEntry = mentalStates.find(s => s.date === dateStr);
    
    let focusValue = ms.focus;
    let motivationValue = ms.motivation;
    
    if (mentalEntry) {
        focusValue = mentalEntry.mood || focusValue;
        motivationValue = mentalEntry.motivation || motivationValue;
    }
    
    let energyValue = (focusValue + motivationValue) / 2;

    document.getElementById('edit-mindset-day-idx').value = dayIdx;
    
    const energyInput = document.getElementById('edit-mindset-energy');
    energyInput.value = energyValue.toFixed(1);
    energyInput.readOnly = true;
    energyInput.style.opacity = "0.6";
    energyInput.style.cursor = "not-allowed";

    let helper = document.getElementById('energy-input-helper');
    if (!helper) {
        helper = document.createElement('p');
        helper.id = 'energy-input-helper';
        helper.style.fontSize = '10px';
        helper.style.color = 'var(--text-muted)';
        helper.style.marginTop = '4px';
        helper.style.lineHeight = '1.4';
        energyInput.parentNode.appendChild(helper);
    }
    helper.textContent = "Energy (Score) is automatically calculated as (Focus + Motivation) / 2.";

    const focusInput = document.getElementById('edit-mindset-focus');
    const motivationInput = document.getElementById('edit-mindset-motivation');

    focusInput.value = focusValue;
    motivationInput.value = motivationValue;

    // Dynamically calculate Energy on real-time input
    const updateModalEnergy = () => {
        const fVal = parseInt(focusInput.value, 10) || 0;
        const mVal = parseInt(motivationInput.value, 10) || 0;
        energyInput.value = ((fVal + mVal) / 2).toFixed(1);
    };

    focusInput.oninput = updateModalEnergy;
    motivationInput.oninput = updateModalEnergy;
    
    document.getElementById('edit-day-mindset-title').textContent = `${weekdays[dayIdx]} - Track Mindset`;
    document.getElementById('edit-day-mindset-modal').classList.add('active');
}

function closeDayMindsetModal() {
    document.getElementById('edit-day-mindset-modal').classList.remove('active');
}

async function submitDayMindset(e) {
    e.preventDefault();
    const dayIdx = parseInt(document.getElementById('edit-mindset-day-idx').value, 10);
    const energy = parseFloat(document.getElementById('edit-mindset-energy').value) || 0;
    const focus = parseInt(document.getElementById('edit-mindset-focus').value, 10) || 0;
    const motivation = parseInt(document.getElementById('edit-mindset-motivation').value, 10) || 0;

    const weekDates = getWeekDates(currentWeekStart);
    const dateStr = weekDates[dayIdx].dateStr;

    try {
        // Save to mindset-tracker
        await fetch('/api/mindset-tracker', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                weekStartDate: currentWeekStart,
                dayOfWeek: dayIdx,
                energy,
                focus,
                motivation
            })
        });

        // ALSO save to daily mental-state (Focus -> Mood, Motivation -> Motivation)
        await fetch('/api/mental-state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                date: dateStr,
                mood: focus,
                motivation: motivation
            })
        });

        closeDayMindsetModal();
        loadTaskTrackerData();
    } catch (err) {
        console.error("Error saving daily mindset:", err);
    }
}

// ==========================================
// 2.5. MONTHLY TRACKER SCRIPTS
// ==========================================

function adjustMonthlyTracker(delta) {
    let [year, month] = currentMonthlyTrackerMonth.split('-').map(Number);
    month += delta;
    if (month > 12) { month = 1; year += 1; }
    else if (month < 1) { month = 12; year -= 1; }
    const val = `${year}-${String(month).padStart(2, '0')}`;
    onMonthlyTrackerPickerChange(val);
}

function onMonthlyTrackerPickerChange(val) {
    if (!val) return;
    currentMonthlyTrackerMonth = val;
    updateMonthlyTrackerTitle();
    loadMonthlyTrackerData();
}

function updateMonthlyTrackerTitle() {
    const parts = currentMonthlyTrackerMonth.split('-');
    const year = parts[0];
    const monthIndex = parseInt(parts[1], 10) - 1;
    const months = getMonthNames();
    const titleEl = document.getElementById('monthly-tracker-title');
    if (titleEl) {
        titleEl.textContent = `${months[monthIndex]} ${year}`;
    }
}

function getWeeksInMonth(monthStr) {
    const [year, month] = monthStr.split('-').map(Number);
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);
    const totalDays = lastDay.getDate();
    
    // Calculate number of weeks needed (using Sunday as start of week)
    const firstDayOfWeek = firstDay.getDay(); // 0 = Sunday
    const weeksNeeded = Math.ceil((totalDays + firstDayOfWeek) / 7);
    
    const weeks = [];
    for (let w = 0; w < weeksNeeded; w++) {
        const startDay = w * 7 - firstDayOfWeek + 1;
        const endDay = Math.min(startDay + 6, totalDays);
        const actualStart = Math.max(startDay, 1);
        
        weeks.push({
            weekIndex: w,
            label: `Week ${w + 1}`,
            dateRange: `${String(actualStart).padStart(2, '0')}–${String(endDay).padStart(2, '0')}`
        });
    }
    return weeks;
}

async function loadMonthlyTrackerData() {
    updateMonthlyTrackerTitle();
    
    try {
        const tasksRes = await fetch(`/api/monthly-tasks?month=${currentMonthlyTrackerMonth}`).then(r => r.json());
        monthlyTasks = Array.isArray(tasksRes) ? tasksRes : [];
        renderMonthlyWeekColumns();
        updateMonthlyCharts();
    } catch (err) {
        console.error("Error loading monthly tracker data:", err);
    }
}

function renderMonthlyWeekColumns() {
    const grid = document.getElementById('monthly-weeks-grid');
    grid.innerHTML = "";

    const weeks = getWeeksInMonth(currentMonthlyTrackerMonth);
    const colors = ["#a855f7", "#3b82f6", "#14b8a6", "#22c55e", "#eab308"];

    // Capture previous percentages for animation
    const prevPercentages = {};
    for (let i = 0; i < weeks.length; i++) {
        const textEl = document.querySelector(`.monthly-week-theme-${i} .day-gauge-text`);
        if (textEl) {
            prevPercentages[i] = parseInt(textEl.textContent, 10) || 0;
        } else {
            prevPercentages[i] = 0;
        }
    }

    // Set grid columns dynamically based on screen width
    if (window.innerWidth <= 768) {
        grid.style.gridTemplateColumns = "1fr";
    } else {
        grid.style.gridTemplateColumns = `repeat(${weeks.length}, minmax(180px, 1fr))`;
    }

    for (let weekIdx = 0; weekIdx < weeks.length; weekIdx++) {
        const week = weeks[weekIdx];
        const weekColor = colors[weekIdx % colors.length];

        const weekTasks = monthlyTasks.filter(t => t.weekOfMonth === weekIdx);
        const completed = weekTasks.filter(t => t.completed).length;
        const total = weekTasks.length;
        const uncompleted = Math.max(0, total - completed);
        const completionPct = total > 0 ? Math.round((completed / total) * 100) : 0;

        // Circular Gauge
        const radius = 25;
        const circ = 2 * Math.PI * radius;
        const prevPct = prevPercentages[weekIdx] !== undefined ? prevPercentages[weekIdx] : 0;
        const initialOffset = circ - (prevPct / 100) * circ;

        const column = document.createElement('div');
        column.className = `day-column monthly-week-theme-${weekIdx}`;
        column.innerHTML = `
            <div class="day-column-header">
                <span class="day-title" style="color: ${weekColor};">${week.label}</span>
                <div class="day-date">${week.dateRange}</div>
                
                <div class="day-gauge-wrapper" title="Week ${weekIdx + 1} progress">
                    <svg viewBox="0 0 60 60" style="width: 100%; height: 100%; transform: rotate(-90deg);">
                        <circle cx="30" cy="30" r="${radius}" fill="none" stroke="rgba(255,255,255,0.03)" stroke-width="5"></circle>
                        <circle id="monthly-gauge-circle-${weekIdx}" cx="30" cy="30" r="${radius}" fill="none" stroke="${weekColor}" stroke-width="6"
                                stroke-dasharray="${circ}" stroke-dashoffset="${initialOffset}" stroke-linecap="round"
                                style="transition: stroke-dashoffset 0.6s cubic-bezier(0.4, 0, 0.2, 1);"></circle>
                    </svg>
                    <span class="day-gauge-text">${completionPct}%</span>
                </div>
            </div>

            <div class="column-tasks-section">
                <span class="tasks-title">Tasks</span>
                <div class="tasks-list-items" id="monthly-tasks-list-week-${weekIdx}">
                </div>
            </div>

            <form class="add-task-form" onsubmit="submitAddMonthlyTask(event, ${weekIdx}, '${weekColor}')">
                <input type="text" class="add-task-input" placeholder="+ Add task..." required>
            </form>

            <div class="column-footer">
                <span>
                    <span class="completed-lbl">Completed</span>
                    <span class="completed-val" style="color: #ffffff;">${completed}</span>
                </span>
                <span>
                    <span class="completed-lbl">Not Completed</span>
                    <span class="completed-val" style="color: #ffffff;">${uncompleted}</span>
                </span>
            </div>
        `;

        grid.appendChild(column);

        // Populate tasks list
        const itemsContainer = column.querySelector(`#monthly-tasks-list-week-${weekIdx}`);
        weekTasks.forEach(task => {
            const taskDiv = document.createElement('div');
            taskDiv.className = `task-item monthly-week-${weekIdx} ${task.completed ? 'checked' : ''}`;
            taskDiv.onclick = (e) => {
                if (e.target.closest('.delete-task-btn')) return;
                toggleMonthlyTask(task._id, task.completed);
            };

            taskDiv.innerHTML = `
                <div class="task-checkbox">
                    <i class="fa-solid fa-check"></i>
                </div>
                <span class="task-text">${task.text}</span>
                <button class="delete-task-btn" onclick="deleteMonthlyTask('${task._id}')" title="Delete Task">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            `;
            itemsContainer.appendChild(taskDiv);
        });
    }

    // Animate gauges
    requestAnimationFrame(() => {
        setTimeout(() => {
            for (let weekIdx = 0; weekIdx < weeks.length; weekIdx++) {
                const weekTasks = monthlyTasks.filter(t => t.weekOfMonth === weekIdx);
                const completed = weekTasks.filter(t => t.completed).length;
                const total = weekTasks.length;
                const completionPct = total > 0 ? Math.round((completed / total) * 100) : 0;

                const radius = 25;
                const circ = 2 * Math.PI * radius;
                const targetOffset = circ - (completionPct / 100) * circ;

                const circle = document.getElementById(`monthly-gauge-circle-${weekIdx}`);
                if (circle) {
                    circle.style.strokeDashoffset = targetOffset;
                }
            }
        }, 50);
    });
}

async function toggleMonthlyTask(taskId, currentStatus) {
    try {
        const res = await fetch(`/api/monthly-tasks/${taskId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ completed: !currentStatus })
        }).then(r => r.json());

        if (res.success) {
            loadMonthlyTrackerData();
        }
    } catch (err) {
        console.error("Error toggling monthly task:", err);
    }
}

async function submitAddMonthlyTask(e, weekIdx, weekColor) {
    e.preventDefault();
    const input = e.target.querySelector('.add-task-input');
    const text = input.value.trim();
    if (!text) return;

    try {
        const res = await fetch('/api/monthly-tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                month: currentMonthlyTrackerMonth,
                weekOfMonth: weekIdx,
                text: text,
                color: weekColor
            })
        }).then(r => r.json());

        if (res._id) {
            input.value = "";
            loadMonthlyTrackerData();
        }
    } catch (err) {
        console.error("Error adding monthly task:", err);
    }
}

async function deleteMonthlyTask(taskId) {
    try {
        const res = await fetch(`/api/monthly-tasks/${taskId}`, { method: 'DELETE' }).then(r => r.json());
        if (res.success) {
            loadMonthlyTrackerData();
        }
    } catch (err) {
        console.error("Error deleting monthly task:", err);
    }
}

function updateMonthlyCharts() {
    const totalTasks = monthlyTasks.length;
    const completedTasks = monthlyTasks.filter(t => t.completed).length;
    const overallPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    // Update Radial Gauge
    const gaugeFill = document.getElementById('monthly-gauge-fill');
    if (gaugeFill) {
        const circ = 251.2;
        const offset = circ - (overallPct / 100) * circ;
        gaugeFill.style.strokeDashoffset = offset;
    }
    document.getElementById('monthly-gauge-percent').textContent = `${overallPct}%`;
    document.getElementById('monthly-gauge-fraction').textContent = `${completedTasks} / ${totalTasks} Completed`;

    // Bar Chart (weekly completion)
    const barCtx = document.getElementById('monthlyProgressBars').getContext('2d');
    const weeks = getWeeksInMonth(currentMonthlyTrackerMonth);
    const weekLabels = weeks.map(w => w.label);
    const colors = ["#a855f7", "#3b82f6", "#14b8a6", "#22c55e", "#eab308"];

    const weeklyCompleted = weeks.map((_, i) => {
        return monthlyTasks.filter(t => t.weekOfMonth === i && t.completed).length;
    });

    const weeklyUncompleted = weeks.map((_, i) => {
        const total = monthlyTasks.filter(t => t.weekOfMonth === i).length;
        const completed = monthlyTasks.filter(t => t.weekOfMonth === i && t.completed).length;
        return Math.max(0, total - completed);
    });

    if (monthlyProgressBarsInstance) {
        monthlyProgressBarsInstance.data.labels = weekLabels;
        monthlyProgressBarsInstance.data.datasets[0].data = weeklyCompleted;
        monthlyProgressBarsInstance.data.datasets[0].backgroundColor = colors.slice(0, weeks.length);
        monthlyProgressBarsInstance.data.datasets[1].data = weeklyUncompleted;
        monthlyProgressBarsInstance.update();
    } else {
        monthlyProgressBarsInstance = new Chart(barCtx, {
            type: 'bar',
            data: {
                labels: weekLabels,
                datasets: [
                    {
                        label: 'Completed',
                        data: weeklyCompleted,
                        backgroundColor: colors.slice(0, weeks.length),
                        borderRadius: 0,
                        barThickness: 18
                    },
                    {
                        label: 'Remaining',
                        data: weeklyUncompleted,
                        backgroundColor: 'rgba(255, 255, 255, 0.06)',
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1,
                        borderRadius: 0,
                        barThickness: 18
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const idx = context.dataIndex;
                                const completed = weeklyCompleted[idx];
                                const uncompleted = weeklyUncompleted[idx];
                                const total = completed + uncompleted;
                                if (context.datasetIndex === 0) {
                                    return `Completed: ${completed} / ${total}`;
                                } else {
                                    return `Remaining: ${uncompleted} / ${total}`;
                                }
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        stacked: true,
                        min: 0,
                        grid: { color: 'rgba(255, 255, 255, 0.03)' },
                        ticks: { color: '#5e6b85', font: { size: 9 }, stepSize: 1 }
                    },
                    x: {
                        stacked: true,
                        grid: { display: false },
                        ticks: { color: '#8f9bb3', font: { size: 9 } }
                    }
                }
            }
        });
    }
}

// Global Modal Overlay click-to-close handler
window.onclick = function(event) {
    if (event.target.classList.contains('modal-overlay')) {
        event.target.classList.remove('active');
    }
}

// Directional Arrow Key & Selection Keyboard Navigation
document.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    if (!active) return;
    
    // 1. Checkbox cells navigation for My Habits table
    if (active.classList.contains('checkbox-cell')) {
        const row = parseInt(active.getAttribute('data-row'), 10);
        const col = parseInt(active.getAttribute('data-col'), 10);
        
        if (e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            active.click();
            return;
        }

        if (e.key === 'Tab') {
            const totalRows = habits.length;
            if (e.shiftKey) {
                // Shift+Tab: Navigate up or wrap to bottom of previous column
                if (row > 0) {
                    e.preventDefault();
                    const nextCell = document.querySelector(`.checkbox-cell[data-row="${row - 1}"][data-col="${col}"]`);
                    if (nextCell) nextCell.focus();
                } else if (row === 0 && col > 1) {
                    e.preventDefault();
                    const nextCell = document.querySelector(`.checkbox-cell[data-row="${totalRows - 1}"][data-col="${col - 1}"]`);
                    if (nextCell) nextCell.focus();
                }
                // Allow default browser tab focus to exit table left boundaries
            } else {
                // Tab: Navigate down or wrap to top of next column
                if (row < totalRows - 1) {
                    e.preventDefault();
                    const nextCell = document.querySelector(`.checkbox-cell[data-row="${row + 1}"][data-col="${col}"]`);
                    if (nextCell) nextCell.focus();
                } else if (row === totalRows - 1 && col < getDaysInCurrentMonth()) {
                    e.preventDefault();
                    const nextCell = document.querySelector(`.checkbox-cell[data-row="0"][data-col="${col + 1}"]`);
                    if (nextCell) nextCell.focus();
                }
                // Allow default browser tab focus to exit table right boundaries
            }
            return;
        }

        let nextRow = row;
        let nextCol = col;
        let shouldNavigate = false;
        const keyLower = e.key.toLowerCase();

        if (e.key === 'ArrowUp' || keyLower === 'w') {
            nextRow = row - 1;
            shouldNavigate = true;
        } else if (e.key === 'ArrowDown' || keyLower === 's') {
            nextRow = row + 1;
            shouldNavigate = true;
        } else if (e.key === 'ArrowLeft' || keyLower === 'a') {
            nextCol = col - 1;
            shouldNavigate = true;
        } else if (e.key === 'ArrowRight' || keyLower === 'd') {
            nextCol = col + 1;
            shouldNavigate = true;
        }

        if (shouldNavigate) {
            e.preventDefault();
            const nextCell = document.querySelector(`.checkbox-cell[data-row="${nextRow}"][data-col="${nextCol}"]`);
            if (nextCell) {
                nextCell.focus();
            }
        }
        return;
    }

    // 2. Standard input element navigation
    if (active.tagName !== 'INPUT' && active.tagName !== 'SELECT') return;
    
    // Ignore date inputs, checkbox inputs, or hidden/submit inputs
    if (active.type === 'date' || active.type === 'submit') return;
    
    const key = e.key.toLowerCase();
    let dir = null;
    if (e.key === 'ArrowUp' || key === 'w') dir = 'up';
    else if (e.key === 'ArrowDown' || key === 's') dir = 'down';
    else if (e.key === 'ArrowLeft' || key === 'a') dir = 'left';
    else if (e.key === 'ArrowRight' || key === 'd') dir = 'right';

    if (!dir) return;

    // If active element is a text input, do NOT allow WASD keys to navigate to prevent blocking typing
    if ((active.type === 'text' || active.tagName === 'TEXTAREA') && ['w', 'a', 's', 'd'].includes(key)) {
        return;
    }
    
    // Find all visible inputs on the page (excluding hidden, date, submit)
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="date"]):not([type="submit"]), select'))
        .filter(el => el.offsetParent !== null);
        
    if (inputs.length <= 1) return;
    
    const activeRect = active.getBoundingClientRect();
    const activeCenter = {
        x: activeRect.left + activeRect.width / 2,
        y: activeRect.top + activeRect.height / 2
    };
    
    let bestMatch = null;
    let bestScore = Infinity;
    
    inputs.forEach(input => {
        if (input === active) return;
        
        const rect = input.getBoundingClientRect();
        const center = {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2
        };
        
        const dx = center.x - activeCenter.x;
        const dy = center.y - activeCenter.y;
        
        let isValid = false;
        let score = 0;
        
        switch (dir) {
            case 'up':
                if (center.y < activeCenter.y - 5) {
                    isValid = true;
                    // Score favors alignment in the current column (vertical)
                    score = Math.abs(dx) * 2 + Math.abs(dy);
                }
                break;
            case 'down':
                if (center.y > activeCenter.y + 5) {
                    isValid = true;
                    score = Math.abs(dx) * 2 + Math.abs(dy);
                }
                break;
            case 'left':
                // For text inputs, only navigate if text selection is at start (or numeric/other types)
                if (active.selectionStart === 0 || active.selectionStart === null || active.type === 'number' || active.tagName === 'SELECT') {
                    if (center.x < activeCenter.x - 5) {
                        isValid = true;
                        // Score favors alignment in the current row (horizontal)
                        score = Math.abs(dx) + Math.abs(dy) * 2;
                    }
                }
                break;
            case 'right':
                // For text inputs, only navigate if text selection is at the end (or numeric/other types)
                const valLength = active.value ? active.value.length : 0;
                if (active.selectionStart === valLength || active.selectionStart === null || active.type === 'number' || active.tagName === 'SELECT') {
                    if (center.x > activeCenter.x + 5) {
                        isValid = true;
                        score = Math.abs(dx) + Math.abs(dy) * 2;
                    }
                }
                break;
        }
        
        if (isValid) {
            if (score < bestScore) {
                bestScore = score;
                bestMatch = input;
            }
        }
    });
    
    if (bestMatch) {
        e.preventDefault();
        bestMatch.focus();
        if (bestMatch.type === 'text' || bestMatch.type === 'number') {
            bestMatch.select();
        }
    }
});

// ==========================================
// 3. CRUD DATA MANAGER SCRIPTS
// ==========================================

// ==========================================
// 3. CRUD DATA MANAGER SCRIPTS
// ==========================================

let currentCrudTab = 'habits';

function switchCrudTab(tabId) {
    currentCrudTab = tabId;
    document.querySelectorAll('.crud-tab-btn').forEach(btn => btn.classList.remove('active'));
    
    // Hide all contents
    document.getElementById('crud-habits').style.display = 'none';
    document.getElementById('crud-tasks').style.display = 'none';
    document.getElementById('crud-mental').style.display = 'none';
    
    document.getElementById(`tab-btn-${tabId}`).classList.add('active');
    document.getElementById(`crud-${tabId}`).style.display = 'block';
    
    if (tabId === 'habits') {
        loadCrudHabits();
    } else if (tabId === 'tasks') {
        loadCrudTasks();
    } else if (tabId === 'mental') {
        loadCrudMental();
    }
}

function loadCrudData() {
    switchCrudTab(currentCrudTab);
}

async function loadCrudHabits() {
    try {
        const habitsRes = await fetch('/api/habits').then(r => r.json());
        const tbody = document.getElementById('crud-habits-tbody');
        tbody.innerHTML = "";
        
        const currentLang = localStorage.getItem('app-lang') || 'en';
        const deleteText = currentLang === 'pt' ? 'Excluir' : 'Delete';
        const addText = currentLang === 'pt' ? 'Adicionar' : 'Add';
        const placeholderText = currentLang === 'pt' ? 'Novo Hábito (ex: Ler 📚)' : 'New Habit (e.g. Read 📚)';
        
        const optManha = currentLang === 'pt' ? 'Manhã' : 'Morning';
        const optAlimentos = currentLang === 'pt' ? 'Alimentos' : 'Nutrition';
        const optHigiene = currentLang === 'pt' ? 'Higiene' : 'Hygiene';
        const optTarde = currentLang === 'pt' ? 'Tarde' : 'Afternoon';
        const optProjeto = currentLang === 'pt' ? 'Projetos' : 'Projects';
        const optNoite = currentLang === 'pt' ? 'Noite' : 'Evening';
        const optGeral = currentLang === 'pt' ? 'Geral' : 'General';

        // Read filters
        const nameFilter = (document.getElementById('filter-habits-name')?.value || "").trim().toLowerCase();
        const catFilter = document.getElementById('filter-habits-cat')?.value || "";

        // Filter habits
        const filteredHabits = habitsRes.filter(habit => {
            const matchesName = !nameFilter || habit.name.toLowerCase().includes(nameFilter);
            const matchesCat = !catFilter || habit.category === catFilter;
            return matchesName && matchesCat;
        });
        
        filteredHabits.forEach(habit => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="padding: 6px 12px; border-bottom: 1px solid var(--border-color);">
                    <input type="text" class="inline-crud-input" value="${habit.name}" onchange="updateHabitInline('${habit._id}', this.value, null)">
                </td>
                <td style="padding: 6px 12px; border-bottom: 1px solid var(--border-color);">
                    <select class="inline-crud-select" onchange="updateHabitInline('${habit._id}', null, this.value)">
                        <option value="manha" ${habit.category === 'manha' ? 'selected' : ''}>${optManha}</option>
                        <option value="alimentos" ${habit.category === 'alimentos' ? 'selected' : ''}>${optAlimentos}</option>
                        <option value="higiene" ${habit.category === 'higiene' ? 'selected' : ''}>${optHigiene}</option>
                        <option value="tarde" ${habit.category === 'tarde' ? 'selected' : ''}>${optTarde}</option>
                        <option value="projeto" ${habit.category === 'projeto' ? 'selected' : ''}>${optProjeto}</option>
                        <option value="noite" ${habit.category === 'noite' ? 'selected' : ''}>${optNoite}</option>
                        <option value="geral" ${habit.category === 'geral' ? 'selected' : ''}>${optGeral}</option>
                    </select>
                </td>
                <td style="padding: 6px 12px; border-bottom: 1px solid var(--border-color); text-align: center;">
                    <button class="crud-btn delete" onclick="deleteHabit('${habit._id}')">
                        <i class="fa-solid fa-trash"></i> ${deleteText}
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
        
        // Add create row at the bottom
        const createTr = document.createElement('tr');
        createTr.className = "inline-create-row";
        createTr.innerHTML = `
            <td><input type="text" id="new-habit-name-inline" placeholder="${placeholderText}" class="inline-crud-input"></td>
            <td>
                <select id="new-habit-cat-inline" class="inline-crud-select">
                    <option value="manha">${optManha}</option>
                    <option value="alimentos">${optAlimentos}</option>
                    <option value="higiene">${optHigiene}</option>
                    <option value="tarde">${optTarde}</option>
                    <option value="projeto">${optProjeto}</option>
                    <option value="noite">${optNoite}</option>
                    <option value="geral">${optGeral}</option>
                </select>
            </td>
            <td style="text-align: center;">
                <button class="crud-btn edit" onclick="submitNewHabitInline()"><i class="fa-solid fa-plus"></i> ${addText}</button>
            </td>
        `;
        tbody.appendChild(createTr);
    } catch (err) {
        console.error("Error loading CRUD habits:", err);
    }
}

async function updateHabitInline(id, name, category) {
    const payload = {};
    if (name !== null) payload.name = name;
    if (category !== null) payload.category = category;
    
    try {
        await fetch(`/api/habits/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        loadHabitTrackerData();
    } catch (err) {
        console.error("Error updating habit inline:", err);
    }
}

async function submitNewHabitInline() {
    const nameInput = document.getElementById('new-habit-name-inline');
    const catSelect = document.getElementById('new-habit-cat-inline');
    const name = nameInput.value.trim();
    const category = catSelect.value;
    
    if (!name) return;
    
    try {
        const res = await fetch('/api/habits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, category })
        }).then(r => r.json());
        
        if (res._id) {
            loadHabitTrackerData();
            loadCrudHabits();
        }
    } catch (err) {
        console.error("Error creating habit inline:", err);
    }
}

async function loadCrudTasks() {
    const weekStart = document.getElementById('crud-task-week').value;
    try {
        const tasksRes = await fetch(`/api/tasks?weekStartDate=${weekStart}`).then(r => r.json());
        const tbody = document.getElementById('crud-tasks-tbody');
        tbody.innerHTML = "";
        
        const currentLang = localStorage.getItem('app-lang') || 'en';
        const deleteText = currentLang === 'pt' ? 'Excluir' : 'Delete';
        const addText = currentLang === 'pt' ? 'Adicionar' : 'Add';
        const placeholderText = currentLang === 'pt' ? 'Descrição da Nova Tarefa...' : 'New Task Description...';
        const pendingText = currentLang === 'pt' ? 'Pendente' : 'Pending';

        const weekdaysNames = currentLang === 'pt' 
            ? ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"]
            : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

        // Read filters
        const textFilter = (document.getElementById('filter-tasks-text')?.value || "").trim().toLowerCase();
        const statusFilter = document.getElementById('filter-tasks-status')?.value || "";

        // Filter tasks
        const filteredTasks = tasksRes.filter(task => {
            const matchesText = !textFilter || task.text.toLowerCase().includes(textFilter);
            let matchesStatus = true;
            if (statusFilter === 'completed') matchesStatus = task.completed === true;
            else if (statusFilter === 'pending') matchesStatus = task.completed === false;
            return matchesText && matchesStatus;
        });

        filteredTasks.forEach(task => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="padding: 6px 12px; border-bottom: 1px solid var(--border-color);">
                    <input type="text" class="inline-crud-input" value="${task.text}" onchange="updateTaskInline('${task._id}', { text: this.value })">
                </td>
                <td style="padding: 6px 12px; border-bottom: 1px solid var(--border-color);">
                    <select class="inline-crud-select" onchange="updateTaskInline('${task._id}', { dayOfWeek: this.value })">
                        <option value="0" ${task.dayOfWeek === 0 ? 'selected' : ''}>${weekdaysNames[0]}</option>
                        <option value="1" ${task.dayOfWeek === 1 ? 'selected' : ''}>${weekdaysNames[1]}</option>
                        <option value="2" ${task.dayOfWeek === 2 ? 'selected' : ''}>${weekdaysNames[2]}</option>
                        <option value="3" ${task.dayOfWeek === 3 ? 'selected' : ''}>${weekdaysNames[3]}</option>
                        <option value="4" ${task.dayOfWeek === 4 ? 'selected' : ''}>${weekdaysNames[4]}</option>
                        <option value="5" ${task.dayOfWeek === 5 ? 'selected' : ''}>${weekdaysNames[5]}</option>
                        <option value="6" ${task.dayOfWeek === 6 ? 'selected' : ''}>${weekdaysNames[6]}</option>
                    </select>
                </td>
                <td style="padding: 6px 12px; border-bottom: 1px solid var(--border-color);">
                    <input type="color" class="inline-crud-color" value="${task.color || '#3b82f6'}" onchange="updateTaskInline('${task._id}', { color: this.value })">
                </td>
                <td style="padding: 6px 12px; border-bottom: 1px solid var(--border-color);">
                    <input type="checkbox" ${task.completed ? 'checked' : ''} onchange="updateTaskInline('${task._id}', { completed: this.checked })" style="width: 18px; height: 18px; cursor: pointer;">
                </td>
                <td style="padding: 6px 12px; border-bottom: 1px solid var(--border-color); text-align: center;">
                    <button class="crud-btn delete" onclick="deleteTask('${task._id}')">
                        <i class="fa-solid fa-trash"></i> ${deleteText}
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
        
        // Add create row at the bottom
        const createTr = document.createElement('tr');
        createTr.className = "inline-create-row";
        createTr.innerHTML = `
            <td><input type="text" id="new-task-text-inline" placeholder="${placeholderText}" class="inline-crud-input"></td>
            <td>
                <select id="new-task-day-inline" class="inline-crud-select">
                    <option value="0">${weekdaysNames[0]}</option>
                    <option value="1">${weekdaysNames[1]}</option>
                    <option value="2">${weekdaysNames[2]}</option>
                    <option value="3">${weekdaysNames[3]}</option>
                    <option value="4">${weekdaysNames[4]}</option>
                    <option value="5">${weekdaysNames[5]}</option>
                    <option value="6">${weekdaysNames[6]}</option>
                </select>
            </td>
            <td><input type="color" id="new-task-color-inline" value="#3b82f6" class="inline-crud-color"></td>
            <td><span class="status-badge pending">${pendingText}</span></td>
            <td style="text-align: center;">
                <button class="crud-btn edit" onclick="submitNewTaskInline()"><i class="fa-solid fa-plus"></i> ${addText}</button>
            </td>
        `;
        tbody.appendChild(createTr);
    } catch (err) {
        console.error("Error loading CRUD tasks:", err);
    }
}

async function updateTaskInline(id, fields) {
    try {
        await fetch(`/api/tasks/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fields)
        });
        loadTaskTrackerData();
    } catch (err) {
        console.error("Error updating task inline:", err);
    }
}

async function submitNewTaskInline() {
    const textInput = document.getElementById('new-task-text-inline');
    const daySelect = document.getElementById('new-task-day-inline');
    const colorInput = document.getElementById('new-task-color-inline');
    const text = textInput.value.trim();
    const dayOfWeek = parseInt(daySelect.value, 10);
    const color = colorInput.value;
    const weekStartDate = document.getElementById('crud-task-week').value;
    
    if (!text) return;
    
    try {
        const res = await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ weekStartDate, dayOfWeek, text, color })
        }).then(r => r.json());
        
        if (res._id) {
            loadTaskTrackerData();
            loadCrudTasks();
        }
    } catch (err) {
        console.error("Error creating task inline:", err);
    }
}

async function loadCrudMental() {
    const monthStr = document.getElementById('crud-mental-month').value;
    try {
        const mentalRes = await fetch(`/api/mental-state?month=${monthStr}`).then(r => r.json());
        const tbody = document.getElementById('crud-mental-tbody');
        tbody.innerHTML = "";
        
        const currentLang = localStorage.getItem('app-lang') || 'en';
        const deleteText = currentLang === 'pt' ? 'Excluir' : 'Delete';
        const addText = currentLang === 'pt' ? 'Adicionar' : 'Add';

        // Read filters
        const minMoodVal = parseInt(document.getElementById('filter-mental-mood')?.value, 10);
        const minMotivVal = parseInt(document.getElementById('filter-mental-motiv')?.value, 10);

        // Filter mental states
        const filteredMental = mentalRes.filter(state => {
            const matchesMood = isNaN(minMoodVal) || state.mood >= minMoodVal;
            const matchesMotiv = isNaN(minMotivVal) || state.motivation >= minMotivVal;
            return matchesMood && matchesMotiv;
        });

        filteredMental.sort((a, b) => a.date.localeCompare(b.date));
        
        filteredMental.forEach(state => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="padding: 6px 12px; border-bottom: 1px solid var(--border-color); color: #fff; font-weight: 500;">
                    ${state.date}
                </td>
                <td style="padding: 6px 12px; border-bottom: 1px solid var(--border-color);">
                    <input type="number" class="inline-crud-input-number" min="1" max="10" value="${state.mood}" onchange="updateMentalInline('${state.date}', 'mood', this.value)">
                </td>
                <td style="padding: 6px 12px; border-bottom: 1px solid var(--border-color);">
                    <input type="number" class="inline-crud-input-number" min="1" max="10" value="${state.motivation}" onchange="updateMentalInline('${state.date}', 'motivation', this.value)">
                </td>
                <td style="padding: 6px 12px; border-bottom: 1px solid var(--border-color); text-align: center;">
                    <button class="crud-btn delete" onclick="deleteMentalState('${state.date}')">
                        <i class="fa-solid fa-trash"></i> ${deleteText}
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
        
        // Add create row at the bottom
        const createTr = document.createElement('tr');
        createTr.className = "inline-create-row";
        createTr.innerHTML = `
            <td><input type="date" id="new-mental-date-inline" class="inline-crud-input" style="padding: 4px 8px; max-width: 140px;"></td>
            <td><input type="number" id="new-mental-mood-inline" min="1" max="10" placeholder="1-10" class="inline-crud-input-number"></td>
            <td><input type="number" id="new-mental-motiv-inline" min="1" max="10" placeholder="1-10" class="inline-crud-input-number"></td>
            <td style="text-align: center;">
                <button class="crud-btn edit" onclick="submitNewMentalInline()"><i class="fa-solid fa-plus"></i> ${addText}</button>
            </td>
        `;
        tbody.appendChild(createTr);
    } catch (err) {
        console.error("Error loading CRUD mental states:", err);
    }
}

async function updateMentalInline(date, key, value) {
    let parsedVal = parseInt(value, 10);
    if (isNaN(parsedVal) || parsedVal < 1 || parsedVal > 10) {
        parsedVal = 5;
    }
    
    try {
        await fetch('/api/mental-state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, [key]: parsedVal })
        });
        loadHabitTrackerData();
        loadTaskTrackerData();
    } catch (err) {
        console.error("Error updating mental state inline:", err);
    }
}

async function submitNewMentalInline() {
    const dateInput = document.getElementById('new-mental-date-inline');
    const moodInput = document.getElementById('new-mental-mood-inline');
    const motivInput = document.getElementById('new-mental-motiv-inline');
    const date = dateInput.value;
    const mood = parseInt(moodInput.value, 10);
    const motivation = parseInt(motivInput.value, 10);
    
    if (!date || isNaN(mood) || isNaN(motivation)) return;
    
    try {
        await fetch('/api/mental-state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, mood, motivation })
        });
        loadHabitTrackerData();
        loadTaskTrackerData();
        loadCrudMental();
    } catch (err) {
        console.error("Error creating mental state inline:", err);
    }
}

// Overwrite deleteTask to refresh views correctly
deleteTask = async function(taskId) {
    const currentLang = localStorage.getItem('app-lang') || 'en';
    if (!confirm(translations[currentLang].confirm_delete_task)) return;
    try {
        const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' }).then(r => r.json());
        if (res.success) {
            loadTaskTrackerData();
            if (document.getElementById('page-data-manager').classList.contains('active')) {
                loadCrudTasks();
            }
        }
    } catch (err) {
        console.error("Error deleting task:", err);
    }
}

// Overwrite deleteHabit to refresh views correctly
deleteHabit = async function(habitId) {
    const currentLang = localStorage.getItem('app-lang') || 'en';
    if (!confirm(translations[currentLang].confirm_delete_habit)) return;
    try {
        const res = await fetch(`/api/habits/${habitId}`, { method: 'DELETE' }).then(r => r.json());
        if (res.success) {
            loadHabitTrackerData();
            if (document.getElementById('page-data-manager').classList.contains('active')) {
                loadCrudHabits();
            }
        }
    } catch (err) {
        console.error("Error deleting habit:", err);
    }
}

// Delete Mental State Log
async function deleteMentalState(dateStr) {
    const currentLang = localStorage.getItem('app-lang') || 'en';
    if (!confirm(translations[currentLang].confirm_delete_mental + dateStr + "?")) return;
    try {
        const res = await fetch(`/api/mental-state/${dateStr}`, { method: 'DELETE' }).then(r => r.json());
        if (res.success) {
            loadHabitTrackerData();
            loadTaskTrackerData();
            if (document.getElementById('page-data-manager').classList.contains('active')) {
                loadCrudMental();
            }
        }
    } catch (err) {
        console.error("Error deleting mental state:", err);
    }
}

// ==========================================
// 4. SOBRIETY COUNTER SCRIPTS
// ==========================================

let lastFallDate = null;
let relapseHistory = [];
let relapseTimerInterval = null;

async function loadRelapseData() {
    try {
        const res = await fetch('/api/last-fall').then(r => r.json());
        if (res.lastFall) {
            lastFallDate = new Date(res.lastFall);
        } else {
            lastFallDate = new Date();
        }
        relapseHistory = res.history || [];

        renderRelapseHistory();
        renderRelapseStats();

        // Setup manual datetime picker max value to local now
        const dtInput = document.getElementById('manual-relapse-datetime');
        if (dtInput) {
            const localNow = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
            dtInput.max = localNow;
            dtInput.value = localNow;
        }

        // Start ticking timer if not already ticking
        if (!relapseTimerInterval) {
            relapseTimerInterval = setInterval(tickRelapseTimer, 1000);
        }
        tickRelapseTimer();
    } catch (err) {
        console.error("Error loading relapse data:", err);
    }
}

function tickRelapseTimer() {
    if (!lastFallDate) return;
    
    const now = new Date();
    const diff = Math.max(0, now - lastFallDate);

    // Total counts in each variable as requested:
    const totalDays = Math.floor(diff / (24 * 3600 * 1000));
    const totalHours = Math.floor(diff / (3600 * 1000));
    const totalMinutes = Math.floor(diff / (60 * 1000));
    const totalSeconds = Math.floor(diff / 1000);

    const daysEl = document.getElementById('counter-days');
    const hoursEl = document.getElementById('counter-hours');
    const minutesEl = document.getElementById('counter-minutes');
    const secondsEl = document.getElementById('counter-seconds');

    if (daysEl) daysEl.textContent = totalDays.toLocaleString();
    if (hoursEl) hoursEl.textContent = totalHours.toLocaleString();
    if (minutesEl) minutesEl.textContent = totalMinutes.toLocaleString();
    if (secondsEl) secondsEl.textContent = totalSeconds.toLocaleString();

    // Clock calculation (Hours, minutes, seconds formatted as HH:MM:SS)
    const displayHours = totalHours;
    const displayMinutes = Math.floor((diff % (3600 * 1000)) / (60 * 1000));
    const displaySeconds = Math.floor((diff % (60 * 1000)) / 1000);

    const clockString = 
        String(displayHours).padStart(2, '0') + ':' + 
        String(displayMinutes).padStart(2, '0') + ':' + 
        String(displaySeconds).padStart(2, '0');

    const clockEl = document.getElementById('big-digital-clock');
    if (clockEl) {
        clockEl.textContent = clockString;
    }

    // Also update current streak real-time
    const currentLang = localStorage.getItem('app-lang') || 'en';
    const currentStreakDays = (diff / (1000 * 60 * 60 * 24)).toFixed(1);
    const currentStreakEl = document.getElementById('stat-current-streak');
    if (currentStreakEl) {
        currentStreakEl.textContent = currentLang === 'pt' ? `${currentStreakDays} dias` : `${currentStreakDays} days`;
    }
}

function renderRelapseHistory() {
    const tbody = document.getElementById('relapse-history-tbody');
    if (!tbody) return;
    tbody.innerHTML = "";

    const currentLang = localStorage.getItem('app-lang') || 'en';

    // Sort descending by end date
    const sortedHistory = [...relapseHistory].sort((a, b) => new Date(b.endDate) - new Date(a.endDate));

    if (sortedHistory.length === 0) {
        const emptyMsg = currentLang === 'pt' ? 'Nenhum histórico de queda registrado.' : 'No relapse history recorded.';
        tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 12px 0;">${emptyMsg}</td></tr>`;
        return;
    }

    sortedHistory.forEach(record => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = "1px solid var(--border-color)";
        
        const dateObj = new Date(record.endDate);
        const formattedDate = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        const days = (record.durationMs / (1000 * 60 * 60 * 24)).toFixed(1);
        const hours = (record.durationMs / (1000 * 60 * 60)).toFixed(0);
        
        const durationText = currentLang === 'pt' ? `${days} dias (${hours}h)` : `${days} days (${hours}h)`;

        tr.innerHTML = `
            <td style="padding: 8px 4px; color: #ffffff;">${formattedDate}</td>
            <td style="padding: 8px 4px; color: var(--text-muted);">${durationText}</td>
            <td style="padding: 8px 4px; text-align: center;">
                <button class="crud-btn delete" onclick="deleteRelapseRecord('${record._id}')" style="padding: 2px 6px; font-size: 11px;">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function renderRelapseStats() {
    const now = new Date();
    const currentDiffMs = Math.max(0, now - lastFallDate);
    const currentLang = localStorage.getItem('app-lang') || 'en';

    // Longest streak
    let longestMs = currentDiffMs;
    relapseHistory.forEach(h => {
        if (h.durationMs > longestMs) longestMs = h.durationMs;
    });
    const longestDays = (longestMs / (1000 * 60 * 60 * 24)).toFixed(1);
    const longestStreakEl = document.getElementById('stat-longest-streak');
    if (longestStreakEl) {
        longestStreakEl.textContent = currentLang === 'pt' ? `${longestDays} dias` : `${longestDays} days`;
    }

    // Average streak
    let sumMs = currentDiffMs;
    let count = 1;
    relapseHistory.forEach(h => {
        sumMs += h.durationMs;
        count++;
    });
    const avgDays = ((sumMs / count) / (1000 * 60 * 60 * 24)).toFixed(1);
    const avgStreakEl = document.getElementById('stat-average-streak');
    if (avgStreakEl) {
        avgStreakEl.textContent = currentLang === 'pt' ? `${avgDays} dias` : `${avgDays} days`;
    }
}

async function registerRelapseNow() {
    const currentLang = localStorage.getItem('app-lang') || 'en';
    if (!confirm(translations[currentLang].confirm_relapse_now)) return;
    
    try {
        const res = await fetch('/api/last-fall', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date: new Date().toISOString() })
        }).then(r => r.json());
        
        if (res.success) {
            loadRelapseData();
        }
    } catch (err) {
        console.error("Error registering relapse now:", err);
    }
}

async function submitManualRelapse(event) {
    event.preventDefault();
    const datetimeVal = document.getElementById('manual-relapse-datetime').value;
    if (!datetimeVal) return;

    const isoDateStr = new Date(datetimeVal).toISOString();

    try {
        const res = await fetch('/api/last-fall', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date: isoDateStr })
        }).then(r => r.json());
        
        if (res.success) {
            loadRelapseData();
        }
    } catch (err) {
        console.error("Error submitting manual relapse:", err);
    }
}

async function deleteRelapseRecord(id) {
    const currentLang = localStorage.getItem('app-lang') || 'en';
    if (!confirm(translations[currentLang].confirm_delete_relapse)) return;

    try {
        const res = await fetch(`/api/relapse-history/${id}`, {
            method: 'DELETE'
        }).then(r => r.json());

        if (res.success) {
            loadRelapseData();
        }
    } catch (err) {
        console.error("Error deleting relapse record:", err);
    }
}

// ==========================================
// 5. FOCUS CANVAS & DRAGGABLE WIDGETS
// ==========================================

let activeDragWidget = null;
let dragStartX, dragStartY;
let widgetInitialLeft, widgetInitialTop;

// Canvas Pan & Zoom State variables
let panX = 0;
let panY = 0;
let zoom = 1.0;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let initialPanX = 0;
let initialPanY = 0;

// Background Images Options
const bgOptions = [
    { name: 'Forest', url: './bg-forest.png', thumb: './bg-forest.png' },
    { name: 'Mist Forest', url: 'https://images.unsplash.com/photo-1448375240586-882707db888b?auto=format&fit=crop&w=300&q=80', original: 'https://images.unsplash.com/photo-1448375240586-882707db888b?auto=format&fit=crop&w=1920&q=80' },
    { name: 'Starry Night', url: 'https://images.unsplash.com/photo-1506318137071-a8e063b4bec0?auto=format&fit=crop&w=300&q=80', original: 'https://images.unsplash.com/photo-1506318137071-a8e063b4bec0?auto=format&fit=crop&w=1920&q=80' },
    { name: 'Cyberpunk', url: 'https://images.unsplash.com/photo-1515621061946-eff1c2a352bd?auto=format&fit=crop&w=300&q=80', original: 'https://images.unsplash.com/photo-1515621061946-eff1c2a352bd?auto=format&fit=crop&w=1920&q=80' },
    { name: 'Sunset Mountain', url: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=300&q=80', original: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=1920&q=80' }
];

// Save widget positions to localStorage
function saveWidgetPositions() {
    const positions = {};
    document.querySelectorAll('.focus-widget').forEach(w => {
        positions[w.id] = {
            left: w.style.left,
            top: w.style.top
        };
    });
    localStorage.setItem('canvas-widget-positions', JSON.stringify(positions));
}

// Load widget positions
function loadWidgetPositions() {
    const raw = localStorage.getItem('canvas-widget-positions');
    if (!raw) return;
    try {
        const positions = JSON.parse(raw);
        for (const [id, pos] of Object.entries(positions)) {
            const w = document.getElementById(id);
            if (w) {
                w.style.left = pos.left;
                w.style.top = pos.top;
            }
        }
    } catch(e) {
        console.error("Error loading widget positions:", e);
    }
}

// Reset canvas layout to defaults
function resetCanvasLayout() {
    const defaults = {
        'widget-timer': { left: '2650px', top: '2750px' },
        'widget-notes': { left: '3070px', top: '2750px' },
        'widget-media': { left: '3070px', top: '2970px' },
        'widget-tasks': { left: '2650px', top: '2970px' }
    };
    for (const [id, pos] of Object.entries(defaults)) {
        const w = document.getElementById(id);
        if (w) {
            w.style.left = pos.left;
            w.style.top = pos.top;
            w.style.display = 'flex'; // Ensure visible
        }
    }
    localStorage.removeItem('canvas-widget-positions');
    resetZoom();
}

// Drag & drop logic
function initDraggableWidgets() {
    const canvasArea = document.getElementById('focus-canvas-area');
    if (!canvasArea) return;

    canvasArea.addEventListener('mousedown', (e) => {
        const header = e.target.closest('.widget-header');
        if (!header) return;
        const widget = header.closest('.widget');
        if (!widget) return;

        // Bring dragged widget to front
        document.querySelectorAll('.focus-widget').forEach(w => w.style.zIndex = 10);
        widget.style.zIndex = 100;

        activeDragWidget = widget;
        widget.classList.add('dragging');
        
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        widgetInitialLeft = parseInt(widget.style.left, 10) || 0;
        widgetInitialTop = parseInt(widget.style.top, 10) || 0;

        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!activeDragWidget) return;
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        
        // Divide movement delta by zoom scale to keep widget locked to pointer
        activeDragWidget.style.left = `${widgetInitialLeft + dx / zoom}px`;
        activeDragWidget.style.top = `${widgetInitialTop + dy / zoom}px`;
    });

    document.addEventListener('mouseup', () => {
        if (!activeDragWidget) return;
        activeDragWidget.classList.remove('dragging');
        activeDragWidget = null;
        saveWidgetPositions();
    });
}

// Obsidian-like Pan & Zoom Logic
function initCanvasInteractions() {
    const canvasArea = document.getElementById('focus-canvas-area');
    const canvasWrapper = document.getElementById('canvas-content-wrapper');
    if (!canvasArea || !canvasWrapper) return;

    // Load zoom & pan from localStorage if exists
    const savedScale = localStorage.getItem('canvas-zoom');
    const savedPanX = localStorage.getItem('canvas-pan-x');
    const savedPanY = localStorage.getItem('canvas-pan-y');
    if (savedScale !== null) zoom = parseFloat(savedScale);
    if (savedPanX !== null) panX = parseFloat(savedPanX);
    if (savedPanY !== null) panY = parseFloat(savedPanY);

    updateCanvasTransform();

    // Zoom on wheel
    canvasArea.addEventListener('wheel', (e) => {
        e.preventDefault();
        
        const rect = canvasArea.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        // Position of mouse relative to canvas wrapper center (transform origin is center center at 3000px, 3000px)
        const canvasMouseX = (mouseX - panX - canvasArea.clientWidth / 2) / zoom + 3000;
        const canvasMouseY = (mouseY - panY - canvasArea.clientHeight / 2) / zoom + 3000;

        const zoomFactor = 1.08;
        if (e.deltaY < 0) {
            zoom = Math.min(2.0, zoom * zoomFactor);
        } else {
            zoom = Math.max(0.3, zoom / zoomFactor);
        }

        // Adjust panX/panY to zoom towards the mouse cursor
        panX = mouseX - canvasArea.clientWidth / 2 - (canvasMouseX - 3000) * zoom;
        panY = mouseY - canvasArea.clientHeight / 2 - (canvasMouseY - 3000) * zoom;

        updateCanvasTransform();
        localStorage.setItem('canvas-zoom', zoom);
        localStorage.setItem('canvas-pan-x', panX);
        localStorage.setItem('canvas-pan-y', panY);
    }, { passive: false });

    // Panning on mousedown on background
    canvasArea.addEventListener('mousedown', (e) => {
        const target = e.target;
        if (target.closest('.widget') || target.closest('.canvas-dock') || target.closest('.editable-canvas-text') || target.closest('button') || target.closest('input') || target.closest('textarea')) {
            return;
        }

        isPanning = true;
        canvasArea.style.cursor = 'grabbing';
        panStartX = e.clientX;
        panStartY = e.clientY;
        initialPanX = panX;
        initialPanY = panY;
        
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isPanning) return;
        
        const dx = e.clientX - panStartX;
        const dy = e.clientY - panStartY;
        
        // Constrain pan boundaries so users don't get lost
        panX = Math.max(-2000, Math.min(2000, initialPanX + dx));
        panY = Math.max(-2000, Math.min(2000, initialPanY + dy));
        
        updateCanvasTransform();
    });

    document.addEventListener('mouseup', () => {
        if (isPanning) {
            isPanning = false;
            canvasArea.style.cursor = 'default';
            localStorage.setItem('canvas-pan-x', panX);
            localStorage.setItem('canvas-pan-y', panY);
        }
    });
}

function updateCanvasTransform() {
    const canvasWrapper = document.getElementById('canvas-content-wrapper');
    if (!canvasWrapper) return;
    
    canvasWrapper.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    
    const display = document.getElementById('canvas-zoom-display');
    if (display) {
        display.textContent = `${Math.round(zoom * 100)}%`;
    }
}

function zoomCanvas(amount) {
    zoom = Math.max(0.3, Math.min(2.0, zoom + amount));
    updateCanvasTransform();
    localStorage.setItem('canvas-zoom', zoom);
}

function resetZoom() {
    zoom = 1.0;
    panX = 0;
    panY = 0;
    updateCanvasTransform();
    localStorage.setItem('canvas-zoom', zoom);
    localStorage.setItem('canvas-pan-x', panX);
    localStorage.setItem('canvas-pan-y', panY);
}

// Toggle Widget Visibility from Dock
function toggleWidget(id) {
    const w = document.getElementById(id);
    if (w) {
        if (w.style.display === 'none') {
            w.style.display = 'flex';
        } else {
            w.style.display = 'none';
        }
    }
}

// Background Picker popover logic
function initBackgroundPicker() {
    const grid = document.getElementById('bg-options-grid');
    if (!grid) return;

    const savedBg = localStorage.getItem('canvas-background') || './bg-forest.png';
    setCanvasBackground(savedBg);

    grid.innerHTML = '';
    bgOptions.forEach(bg => {
        const card = document.createElement('div');
        card.style.cssText = `
            cursor: pointer;
            border-radius: 6px;
            overflow: hidden;
            border: 2px solid ${savedBg === (bg.original || bg.url) ? 'var(--primary-blue)' : 'rgba(255,255,255,0.1)'};
            transition: all 0.2s;
            position: relative;
            aspect-ratio: 16/10;
        `;
        card.className = 'bg-option-card';
        card.onclick = () => {
            document.querySelectorAll('.bg-option-card').forEach(c => c.style.borderColor = 'rgba(255,255,255,0.1)');
            card.style.borderColor = 'var(--primary-blue)';
            setCanvasBackground(bg.original || bg.url);
        };

        const img = document.createElement('img');
        img.src = bg.thumb || bg.url;
        img.style.cssText = 'width: 100%; height: 100%; object-fit: cover; display: block;';
        card.appendChild(img);

        const name = document.createElement('span');
        name.textContent = bg.name;
        name.style.cssText = 'position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.65); color: #fff; font-size: 8px; padding: 2px; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: sans-serif;';
        card.appendChild(name);

        grid.appendChild(card);
    });
}

function setCanvasBackground(bgUrl) {
    const page = document.getElementById('page-focus-canvas');
    if (page) {
        page.style.backgroundImage = `url('${bgUrl}')`;
        localStorage.setItem('canvas-background', bgUrl);
    }
}

function toggleBgPicker() {
    const popover = document.getElementById('bg-picker-popover');
    if (popover) {
        popover.style.display = popover.style.display === 'none' ? 'flex' : 'none';
    }
}

// Close background picker when clicking outside
document.addEventListener('click', (e) => {
    const popover = document.getElementById('bg-picker-popover');
    const trigger = document.getElementById('bg-picker-trigger');
    if (popover && trigger && popover.style.display === 'flex') {
        if (!popover.contains(e.target) && !trigger.contains(e.target)) {
            popover.style.display = 'none';
        }
    }
});

// Editable Greeting & Quote (double click)
function initEditableCanvasText() {
    const greeting = document.getElementById('canvas-greeting');
    const quote = document.getElementById('canvas-quote');

    if (greeting) {
        const saved = localStorage.getItem('canvas-greeting-text');
        if (saved) greeting.textContent = saved;

        greeting.addEventListener('dblclick', () => {
            const current = greeting.textContent;
            const input = document.createElement('input');
            input.type = 'text';
            input.value = current;
            input.style.cssText = 'background: rgba(0,0,0,0.7); border: 1px solid var(--primary-blue); color: #fff; font-size: 20px; font-weight: 600; text-align: center; border-radius: 6px; padding: 6px 12px; font-family: inherit; width: 100%; max-width: 500px; outline: none; box-shadow: 0 4px 20px rgba(0,0,0,0.5);';
            
            greeting.replaceWith(input);
            input.focus();
            input.select();

            const finishEdit = () => {
                const val = input.value.trim() || 'Aesthetic Canvas';
                greeting.textContent = val;
                localStorage.setItem('canvas-greeting-text', val);
                input.replaceWith(greeting);
            };

            input.addEventListener('blur', finishEdit);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') finishEdit();
                if (e.key === 'Escape') {
                    input.replaceWith(greeting);
                }
            });
        });
    }

    if (quote) {
        const saved = localStorage.getItem('canvas-quote-text');
        if (saved) quote.textContent = saved;

        quote.addEventListener('dblclick', () => {
            const current = quote.textContent;
            const input = document.createElement('input');
            input.type = 'text';
            input.value = current;
            input.style.cssText = 'background: rgba(0,0,0,0.7); border: 1px solid var(--primary-blue); color: #fff; font-size: 14px; font-style: italic; text-align: center; border-radius: 6px; padding: 6px 12px; font-family: inherit; width: 100%; max-width: 400px; outline: none; box-shadow: 0 4px 20px rgba(0,0,0,0.5);';
            
            quote.replaceWith(input);
            input.focus();
            input.select();

            const finishEdit = () => {
                const val = input.value.trim() || '"Stay focused"';
                quote.textContent = val;
                localStorage.setItem('canvas-quote-text', val);
                input.replaceWith(quote);
            };

            input.addEventListener('blur', finishEdit);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') finishEdit();
                if (e.key === 'Escape') {
                    input.replaceWith(quote);
                }
            });
        });
    }
}

// Canvas Live Digital Clock
function startCanvasClock() {
    const clockEl = document.getElementById('canvas-clock');
    if (!clockEl) return;
    
    function updateClock() {
        const now = new Date();
        const hrs = String(now.getHours()).padStart(2, '0');
        const mins = String(now.getMinutes()).padStart(2, '0');
        clockEl.textContent = `${hrs}:${mins}`;
    }
    
    updateClock();
    setInterval(updateClock, 1000);
}

// Focus Timer Logic
let focusTimerInterval = null;
let focusTimerMode = 'pomodoro'; // 'pomodoro', 'short', 'stopwatch'
let focusTimerSeconds = 25 * 60; // Default 25 min
let isFocusTimerRunning = false;

function setTimerMode(mode) {
    focusTimerMode = mode;
    isFocusTimerRunning = false;
    if (focusTimerInterval) {
        clearInterval(focusTimerInterval);
        focusTimerInterval = null;
    }
    
    // Toggle active tabs styling
    document.querySelectorAll('.timer-tab').forEach(btn => btn.classList.remove('active'));
    
    const playBtn = document.getElementById('focus-timer-play-btn');
    if (playBtn) {
        const currentLang = localStorage.getItem('app-lang') || 'en';
        playBtn.innerHTML = `<i class="fa-solid fa-play"></i> ${currentLang === 'pt' ? 'Iniciar' : 'Start'}`;
        playBtn.style.background = 'var(--primary-blue)';
    }

    if (mode === 'pomodoro') {
        document.getElementById('tab-pomo').classList.add('active');
        focusTimerSeconds = 25 * 60;
    } else if (mode === 'short') {
        document.getElementById('tab-short').classList.add('active');
        focusTimerSeconds = 5 * 60;
    } else if (mode === 'stopwatch') {
        document.getElementById('tab-stopwatch').classList.add('active');
        focusTimerSeconds = 0;
    }

    updateFocusTimerDisplay();
}

function updateFocusTimerDisplay() {
    const display = document.getElementById('focus-clock-display');
    if (!display) return;

    if (focusTimerMode === 'stopwatch') {
        const hours = Math.floor(focusTimerSeconds / 3600);
        const minutes = Math.floor((focusTimerSeconds % 3600) / 60);
        const seconds = focusTimerSeconds % 60;
        
        let str = "";
        if (hours > 0) {
            str += String(hours).padStart(2, '0') + ':';
        }
        str += String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
        display.textContent = str;
    } else {
        const minutes = Math.floor(focusTimerSeconds / 60);
        const seconds = focusTimerSeconds % 60;
        display.textContent = String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }
}

function toggleFocusTimer() {
    isFocusTimerRunning = !isFocusTimerRunning;
    const playBtn = document.getElementById('focus-timer-play-btn');
    const currentLang = localStorage.getItem('app-lang') || 'en';

    if (isFocusTimerRunning) {
        if (playBtn) {
            playBtn.innerHTML = `<i class="fa-solid fa-pause"></i> ${currentLang === 'pt' ? 'Pausar' : 'Pause'}`;
            playBtn.style.background = 'var(--primary-red)';
        }

        focusTimerInterval = setInterval(() => {
            if (focusTimerMode === 'stopwatch') {
                focusTimerSeconds++;
            } else {
                focusTimerSeconds--;
                if (focusTimerSeconds <= 0) {
                    clearInterval(focusTimerInterval);
                    focusTimerInterval = null;
                    isFocusTimerRunning = false;
                    focusTimerSeconds = 0;
                    playAlarmSound();
                    
                    if (playBtn) {
                        playBtn.innerHTML = `<i class="fa-solid fa-play"></i> ${currentLang === 'pt' ? 'Iniciar' : 'Start'}`;
                        playBtn.style.background = 'var(--primary-blue)';
                    }
                }
            }
            updateFocusTimerDisplay();
        }, 1000);
    } else {
        if (playBtn) {
            playBtn.innerHTML = `<i class="fa-solid fa-play"></i> ${currentLang === 'pt' ? 'Iniciar' : 'Start'}`;
            playBtn.style.background = 'var(--primary-blue)';
        }
        if (focusTimerInterval) {
            clearInterval(focusTimerInterval);
            focusTimerInterval = null;
        }
    }
}

function resetFocusTimer() {
    setTimerMode(focusTimerMode);
}

function playAlarmSound() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5 tone
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);

        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        oscillator.start();
        setTimeout(() => {
            oscillator.stop();
        }, 800);
    } catch(e) {
        console.warn("Alarm sound played but blocked by browser policy");
    }
}

// Sticky Notes Persistence
function loadStickyNote() {
    const text = localStorage.getItem('canvas-sticky-text') || "";
    const color = localStorage.getItem('canvas-sticky-color') || '#fef08a';
    
    const textarea = document.getElementById('sticky-note-textarea');
    if (textarea) textarea.value = text;
    setStickyColor(color);
}

function saveStickyNote() {
    const val = document.getElementById('sticky-note-textarea').value;
    localStorage.setItem('canvas-sticky-text', val);
}

function setStickyColor(color) {
    const note = document.getElementById('widget-notes');
    if (!note) return;
    
    note.style.background = hexToRgba(color, 0.1);
    note.style.borderColor = hexToRgba(color, 0.3);
    
    const headerTitle = note.querySelector('.widget-header span');
    if (headerTitle) headerTitle.style.color = color;
    
    const grip = note.querySelector('.widget-header i:last-child');
    if (grip) grip.style.color = hexToRgba(color, 0.4);

    localStorage.setItem('canvas-sticky-color', color);
}

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Media Player Embed Logic
function loadMediaUrl() {
    const urlInput = document.getElementById('media-embed-url');
    if (!urlInput) return;
    let url = urlInput.value.trim();
    if (!url) return;

    const iframe = document.getElementById('media-iframe');
    if (!iframe) return;

    // Convert links to embed format
    if (url.includes('spotify.com')) {
        if (!url.includes('/embed/')) {
            url = url.replace('spotify.com/', 'spotify.com/embed/');
        }
    } else if (url.includes('youtube.com/watch') || url.includes('youtu.be')) {
        let videoId = "";
        if (url.includes('v=')) {
            videoId = url.split('v=')[1].split('&')[0];
        } else {
            videoId = url.split('/').pop().split('?')[0];
        }
        url = `https://www.youtube.com/embed/${videoId}`;
    } else if (url.includes('youtube.com/playlist')) {
        let listId = url.split('list=')[1].split('&')[0];
        url = `https://www.youtube.com/embed/videoseries?list=${listId}`;
    }

    iframe.src = url;
    localStorage.setItem('canvas-media-url', url);
}

function initMediaIframe() {
    const saved = localStorage.getItem('canvas-media-url');
    if (saved) {
        const iframe = document.getElementById('media-iframe');
        if (iframe) iframe.src = saved;
        const input = document.getElementById('media-embed-url');
        if (input) input.value = saved;
    }
}

// Canvas To-do Widget Logic
let canvasTodos = [];

function loadCanvasTodos() {
    const raw = localStorage.getItem('canvas-todos');
    if (raw) {
        try {
            canvasTodos = JSON.parse(raw);
        } catch(e) {
            canvasTodos = [];
        }
    } else {
        canvasTodos = [
            { text: "Drink water 💧", completed: false },
            { text: "Review study guide 📚", completed: true }
        ];
    }
    renderCanvasTodos();
}

function saveCanvasTodos() {
    localStorage.setItem('canvas-todos', JSON.stringify(canvasTodos));
}

function renderCanvasTodos() {
    const container = document.getElementById('canvas-todo-items');
    if (!container) return;
    container.innerHTML = "";

    if (canvasTodos.length === 0) {
        const currentLang = localStorage.getItem('app-lang') || 'en';
        container.innerHTML = `<span style="font-size:11px; color: var(--text-muted); text-align:center; padding:10px 0; display:block;">${currentLang === 'pt' ? 'Sem tarefas rápidas.' : 'No quick tasks.'}</span>`;
        return;
    }

    canvasTodos.forEach((todo, idx) => {
        const item = document.createElement('div');
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.justifyContent = 'space-between';
        item.style.background = 'rgba(0,0,0,0.15)';
        item.style.padding = '6px 8px';
        item.style.borderRadius = '4px';

        const left = document.createElement('div');
        left.style.display = 'flex';
        left.style.alignItems = 'center';
        left.style.gap = '8px';

        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = todo.completed;
        check.style.cursor = 'pointer';
        check.onchange = () => {
            canvasTodos[idx].completed = check.checked;
            saveCanvasTodos();
            renderCanvasTodos();
        };

        const span = document.createElement('span');
        span.textContent = todo.text;
        span.style.fontSize = '12px';
        span.style.color = todo.completed ? 'var(--text-muted)' : '#fff';
        span.style.textDecoration = todo.completed ? 'line-through' : 'none';

        left.appendChild(check);
        left.appendChild(span);

        const delBtn = document.createElement('button');
        delBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        delBtn.style.background = 'none';
        delBtn.style.border = 'none';
        delBtn.style.color = 'var(--text-muted)';
        delBtn.style.cursor = 'pointer';
        delBtn.style.fontSize = '12px';
        delBtn.onclick = () => {
            canvasTodos.splice(idx, 1);
            saveCanvasTodos();
            renderCanvasTodos();
        };

        item.appendChild(left);
        item.appendChild(delBtn);
        container.appendChild(item);
    });
}

function addCanvasTodo(e) {
    e.preventDefault();
    const input = document.getElementById('new-canvas-todo-input');
    if (!input) return;
    const txt = input.value.trim();
    if (!txt) return;

    canvasTodos.push({ text: txt, completed: false });
    saveCanvasTodos();
    renderCanvasTodos();
    input.value = "";
}

// Admin Data Operations: Clear and Seed
async function clearAllData() {
    const confirmClear = confirm("Are you sure you want to delete all database logs and records? A backup folder containing all your current JSON data will be created.");
    if (!confirmClear) return;

    try {
        const response = await fetch('/api/admin/clear-all', { method: 'POST' });
        const result = await response.json();
        if (result.success) {
            alert(`All database collections cleared successfully!\nBackup saved to: ${result.backupPath}`);
            // Reload the current page to update charts and tables
            location.reload();
        } else {
            alert(`Error clearing database: ${result.error}`);
        }
    } catch (err) {
        console.error("Error calling clear-all API:", err);
        alert("Failed to clear database. Check console for details.");
    }
}

async function seedTestData() {
    const confirmSeed = confirm("Are you sure you want to reset the database and seed it with clean, random test data?");
    if (!confirmSeed) return;

    try {
        const response = await fetch('/api/admin/seed-test-data', { method: 'POST' });
        const result = await response.json();
        if (result.success) {
            alert("Database successfully reset and seeded with test data!");
            location.reload();
        } else {
            alert(`Error seeding database: ${result.error}`);
        }
    } catch (err) {
        console.error("Error calling seed-test-data API:", err);
        alert("Failed to seed database. Check console for details.");
    }
}

// ==========================================
// 7. DAILY NOTES CODE
// ==========================================
let currentNotesMonth = `${_curY}-${_curM}`;
let activeNoteDate = `${_curY}-${_curM}-${_curD}`;
let dailyNotes = [];
let noteSaveTimeout = null;

async function loadDailyNotesData() {
    try {
        const res = await fetch('/api/daily-notes').then(r => r.json());
        dailyNotes = Array.isArray(res) ? res : [];
        updateNotesMonthTitle();
        renderNotesDaysList();
        loadActiveNote();
    } catch (err) {
        console.error("Error loading daily notes:", err);
    }
}

function adjustNotesMonth(delta) {
    let [year, month] = currentNotesMonth.split('-').map(Number);
    month += delta;
    if (month > 12) {
        month = 1;
        year += 1;
    } else if (month < 1) {
        month = 12;
        year -= 1;
    }
    const val = `${year}-${String(month).padStart(2, '0')}`;
    onNotesMonthPickerChange(val);
}

function onNotesMonthPickerChange(val) {
    if (!val) return;
    currentNotesMonth = val;
    updateNotesMonthTitle();
    // Set active note to first day of new month
    activeNoteDate = `${val}-01`;
    loadDailyNotesData();
}

function updateNotesMonthTitle() {
    const parts = currentNotesMonth.split('-');
    const year = parts[0];
    const monthIndex = parseInt(parts[1], 10) - 1;
    const months = getMonthNames();
    const titleEl = document.getElementById('notes-month-title');
    if (titleEl) {
        titleEl.textContent = `${months[monthIndex]} ${year}`;
    }
}

function renderNotesDaysList() {
    const listContainer = document.getElementById('notes-days-list');
    if (!listContainer) return;
    listContainer.innerHTML = "";

    const parts = currentNotesMonth.split('-');
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const daysInMonth = new Date(year, month, 0).getDate();

    const currentLang = localStorage.getItem('app-lang') || 'en';
    const weekdays = currentLang === 'pt' ? 
        ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"] : 
        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    for (let day = 1; day <= daysInMonth; day++) {
        const dayStr = String(day).padStart(2, '0');
        const dateStr = `${currentNotesMonth}-${dayStr}`;
        const dateObj = new Date(year, month - 1, day);
        const weekdayName = weekdays[dateObj.getDay()];

        const note = Array.isArray(dailyNotes) ? dailyNotes.find(n => n.date === dateStr) : null;
        const hasNote = note && note.content && note.content.trim().length > 0;
        
        const item = document.createElement('div');
        item.className = `notes-day-item`;
        if (hasNote) item.className += " has-note";
        if (dateStr === activeNoteDate) item.className += " active";

        const indicatorContent = hasNote ? (note.mood || '<i class="fa-solid fa-check"></i>') : '<i class="fa-regular fa-pen-to-square" style="opacity: 0.3;"></i>';
        
        item.innerHTML = `
            <span style="font-weight: 500;">${day} <span style="font-size: 11px; opacity: 0.6; margin-left: 4px;">(${weekdayName})</span></span>
            <span class="indicator">${indicatorContent}</span>
        `;

        item.onclick = () => {
            activeNoteDate = dateStr;
            document.querySelectorAll('.notes-day-item').forEach(el => el.classList.remove('active'));
            item.classList.add('active');
            loadActiveNote();
        };

        listContainer.appendChild(item);
    }
}

function loadActiveNote() {
    const parts = activeNoteDate.split('-');
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const day = parseInt(parts[2], 10);
    const dateObj = new Date(year, month - 1, day);

    const currentLang = localStorage.getItem('app-lang') || 'en';
    const weekdaysFull = currentLang === 'pt' ? 
        ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"] : 
        ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const monthsFull = getMonthNames();

    const weekdayStr = weekdaysFull[dateObj.getDay()];
    const monthName = monthsFull[month - 1];

    const label = document.getElementById('active-note-date-label');
    if (label) {
        if (currentLang === 'pt') {
            label.textContent = `${weekdayStr}, ${day} de ${monthName} de ${year}`;
        } else {
            label.textContent = `${weekdayStr}, ${monthName} ${day}, ${year}`;
        }
    }

    const note = Array.isArray(dailyNotes) ? dailyNotes.find(n => n.date === activeNoteDate) : null;
    const textarea = document.getElementById('note-textarea');
    const tagsInput = document.getElementById('note-tags-input');

    if (textarea) textarea.value = "";
    if (tagsInput) tagsInput.value = "";
    document.querySelectorAll('.note-mood-selector .mood-btn').forEach(btn => btn.classList.remove('active'));

    if (note) {
        if (textarea) textarea.value = note.content || "";
        if (tagsInput) {
            if (note.tags) {
                if (Array.isArray(note.tags)) {
                    tagsInput.value = note.tags.join(', ');
                } else if (typeof note.tags === 'string') {
                    let cleanTags = note.tags;
                    if (cleanTags.startsWith('{') && cleanTags.endsWith('}')) {
                        cleanTags = cleanTags.slice(1, -1);
                    }
                    tagsInput.value = cleanTags.split(',').map(t => t.trim()).filter(t => t.length > 0).join(', ');
                } else {
                    tagsInput.value = "";
                }
            } else {
                tagsInput.value = "";
            }
        }
        if (note.mood) {
            const moodBtn = Array.from(document.querySelectorAll('.note-mood-selector .mood-btn')).find(b => b.textContent.trim() === note.mood);
            if (moodBtn) moodBtn.classList.add('active');
        }
    }

    updateNoteWordCharCount();
    renderNoteTagsBadges();
    
    const saveStatus = document.getElementById('note-save-status');
    if (saveStatus) {
        saveStatus.textContent = currentLang === 'pt' ? "Salvo" : "Saved";
        saveStatus.style.color = "var(--text-muted)";
    }
}

function setNoteMood(mood) {
    const activeBtn = Array.from(document.querySelectorAll('.note-mood-selector .mood-btn')).find(b => b.textContent.trim() === mood);
    
    if (activeBtn && activeBtn.classList.contains('active')) {
        activeBtn.classList.remove('active');
    } else {
        document.querySelectorAll('.note-mood-selector .mood-btn').forEach(btn => btn.classList.remove('active'));
        if (activeBtn) activeBtn.classList.add('active');
    }
    saveActiveNote();
}

function renderNoteTagsBadges() {
    const badgeContainer = document.getElementById('note-tags-badges');
    if (!badgeContainer) return;
    badgeContainer.innerHTML = "";

    const tagsInput = document.getElementById('note-tags-input');
    if (!tagsInput) return;

    const tags = tagsInput.value.split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);

    tags.forEach(tag => {
        const badge = document.createElement('span');
        badge.className = "category-badge mind";
        badge.style.borderRadius = "4px";
        badge.style.fontSize = "10px";
        badge.style.padding = "2px 6px";
        badge.textContent = tag;
        badgeContainer.appendChild(badge);
    });
}

function updateNoteWordCharCount() {
    const textarea = document.getElementById('note-textarea');
    const counter = document.getElementById('note-word-char-count');
    if (!textarea || !counter) return;

    const text = textarea.value;
    const charCount = text.length;
    const wordCount = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;

    const currentLang = localStorage.getItem('app-lang') || 'en';
    if (currentLang === 'pt') {
        counter.textContent = `Palavras: ${wordCount} | Caracteres: ${charCount}`;
    } else {
        counter.textContent = `Words: ${wordCount} | Characters: ${charCount}`;
    }
}

function onNoteInput() {
    updateNoteWordCharCount();
    
    const saveStatus = document.getElementById('note-save-status');
    const currentLang = localStorage.getItem('app-lang') || 'en';
    if (saveStatus) {
        saveStatus.textContent = currentLang === 'pt' ? "Digitando..." : "Typing...";
        saveStatus.style.color = "var(--accent-yellow)";
    }

    if (noteSaveTimeout) clearTimeout(noteSaveTimeout);
    noteSaveTimeout = setTimeout(saveActiveNote, 1000);
}

async function saveActiveNote() {
    const textarea = document.getElementById('note-textarea');
    const tagsInput = document.getElementById('note-tags-input');
    const activeMoodBtn = document.querySelector('.note-mood-selector .mood-btn.active');
    
    if (!textarea) return;

    const content = textarea.value;
    const mood = activeMoodBtn ? activeMoodBtn.textContent.trim() : "";
    const tags = tagsInput ? tagsInput.value.split(',').map(t => t.trim()).filter(t => t.length > 0) : [];

    const currentLang = localStorage.getItem('app-lang') || 'en';
    const saveStatus = document.getElementById('note-save-status');
    if (saveStatus) {
        saveStatus.textContent = currentLang === 'pt' ? "Salvando..." : "Saving...";
        saveStatus.style.color = "var(--primary-blue)";
    }

    try {
        const res = await fetch('/api/daily-notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                date: activeNoteDate,
                content,
                mood,
                tags
            })
        }).then(r => r.json());

        if (res.success) {
            const idx = dailyNotes.findIndex(n => n.date === activeNoteDate);
            const noteObj = { date: activeNoteDate, content, mood, tags };
            if (idx === -1) {
                dailyNotes.push(noteObj);
            } else {
                dailyNotes[idx] = noteObj;
            }

            renderNotesDaysList();
            renderNoteTagsBadges();

            if (saveStatus) {
                saveStatus.textContent = currentLang === 'pt' ? "Salvo" : "Saved";
                saveStatus.style.color = "var(--accent-green)";
            }
        }
    } catch (err) {
        console.error("Error saving active note:", err);
        if (saveStatus) {
            saveStatus.textContent = currentLang === 'pt' ? "Erro ao salvar" : "Save error";
            saveStatus.style.color = "var(--accent-orange)";
        }
    }
}
