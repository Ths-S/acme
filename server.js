const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const createDB = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize file-based NoSQL database
const dbDir = path.join(__dirname, 'data');
const db = createDB(dbDir);

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Seed helper functions
async function seedDefaultHabits() {
    const habitsColl = db.collection('habits');
    const existing = await habitsColl.find();
    if (existing.length > 0) return;

    const defaultHabits = [
        // Manhã
        { name: "Acordar antes de 6:15 ⏰", category: "manha" },
        // Alimentos
        { name: "Café ☕", category: "alimentos" },
        { name: "Creatina 🧪", category: "alimentos" },
        { name: "Remédios 💊", category: "alimentos" },
        { name: "Pão com Ovo 🍳", category: "alimentos" },
        // Higiene
        { name: "Escovar os Dentes 1 🪥", category: "higiene" },
        { name: "Protetor solar ☀️", category: "higiene" },
        { name: "Sabonete gel anti acne 🧼", category: "higiene" },
        { name: "Cicatricure Creme Corporal 🧴", category: "higiene" },
        // Tarde
        { name: "Escovar os Dentes 2 🪥", category: "tarde" },
        // Proj.
        { name: "1h de Projeto 💻", category: "projeto" },
        { name: "Academia 🏋️", category: "projeto" },
        // Higi.
        { name: "Banho assim que chegar 🚿", category: "higiene" },
        { name: "Bio-Oil (depois do último banho) 🧴", category: "higiene" },
        { name: "Sabonete gel anti acne (Tarde) 🧼", category: "higiene" },
        // Noite
        { name: "Escovar Dentes 3 🪥", category: "noite" },
        { name: "Meditar 🧘", category: "noite" },
        { name: "Anotações e Pesquisas 📝", category: "noite" },
        { name: "Cenário 🎬", category: "noite" },
        { name: "Ir Dormir 21h 😴", category: "noite" },
        { name: "Estar dormindo 22h 💤", category: "noite" },
        // Geral
        { name: "Beber 4 litros de água 💧", category: "geral" },
        { name: "Sem Vício 🚫", category: "geral" }
    ];

    for (const h of defaultHabits) {
        await habitsColl.insert(h);
    }
    console.log("Default habits seeded!");
}

async function seedDefaultHabitEntries() {
    const entriesColl = db.collection('habit_entries');
    const habitsColl = db.collection('habits');
    
    const existing = await entriesColl.find();
    if (existing.length > 0) return;

    const habits = await habitsColl.find();
    if (habits.length === 0) return;

    const completionRates = {
        "Acordar antes de 6:15 ⏰": 0.85,
        "Café ☕": 0.90,
        "Creatina 🧪": 0.75,
        "Remédios 💊": 0.95,
        "Pão com Ovo 🍳": 0.80,
        "Escovar os Dentes 1 🪥": 0.95,
        "Protetor solar ☀️": 0.60,
        "Sabonete gel anti acne 🧼": 0.70,
        "Cicatricure Creme Corporal 🧴": 0.50,
        "Escovar os Dentes 2 🪥": 0.90,
        "1h de Projeto 💻": 0.65,
        "Academia 🏋️": 0.70,
        "Banho assim que chegar 🚿": 0.85,
        "Bio-Oil (depois do último banho) 🧴": 0.60,
        "Sabonete gel anti acne (Tarde) 🧼": 0.70,
        "Escovar Dentes 3 🪥": 0.95,
        "Meditar 🧘": 0.50,
        "Anotações e Pesquisas 📝": 0.60,
        "Cenário 🎬": 0.40,
        "Ir Dormir 21h 😴": 0.45,
        "Estar dormindo 22h 💤": 0.40,
        "Beber 4 litros de água 💧": 0.75,
        "Sem Vício 🚫": 0.90
    };

    const now = new Date();
    const curY = now.getFullYear();
    const curM = String(now.getMonth() + 1).padStart(2, '0');
    const currentMonthStr = `${curY}-${curM}`;
    const daysInCurMonth = new Date(curY, now.getMonth() + 1, 0).getDate();

    // Seed both Jan 2026 and current month
    const monthsToSeed = [
        { month: "2026-01", days: 31 }
    ];
    if (currentMonthStr !== "2026-01") {
        monthsToSeed.push({ month: currentMonthStr, days: daysInCurMonth });
    }

    for (const item of monthsToSeed) {
        let completedCount = 0;
        const targetCompleted = Math.round(habits.length * item.days * 0.58);
        const monthEntries = [];

        for (let day = 1; day <= item.days; day++) {
            const dateStr = `${item.month}-${String(day).padStart(2, '0')}`;
            for (const habit of habits) {
                const baseRate = completionRates[habit.name] || 0.5;
                const dayFactor = Math.sin(day) * 0.15 + 0.95; 
                const completed = Math.random() < (baseRate * dayFactor);
                
                const entry = {
                    date: dateStr,
                    habitId: habit._id,
                    completed: completed
                };
                monthEntries.push(entry);
                if (completed) completedCount++;
            }
        }

        // Force completion percentage to ~58%
        const diff = targetCompleted - completedCount;
        if (diff > 0) {
            const uncompleted = monthEntries.filter(e => !e.completed);
            const toChange = uncompleted.sort(() => 0.5 - Math.random()).slice(0, diff);
            for (const entry of toChange) {
                entry.completed = true;
            }
        } else if (diff < 0) {
            const completed = monthEntries.filter(e => e.completed);
            const toChange = completed.sort(() => 0.5 - Math.random()).slice(0, Math.abs(diff));
            for (const entry of toChange) {
                entry.completed = false;
            }
        }

        for (const entry of monthEntries) {
            await entriesColl.insert(entry);
        }
    }
    console.log("Default habit entries seeded successfully!");
}

async function seedDefaultMentalState() {
    const mentalColl = db.collection('mental_state');
    const existing = await mentalColl.find();
    if (existing.length > 0) return;

    const now = new Date();
    const curY = now.getFullYear();
    const curM = String(now.getMonth() + 1).padStart(2, '0');
    const currentMonthStr = `${curY}-${curM}`;
    const daysInCurMonth = new Date(curY, now.getMonth() + 1, 0).getDate();

    const monthsToSeed = [
        { month: "2026-01", days: 31 }
    ];
    if (currentMonthStr !== "2026-01") {
        monthsToSeed.push({ month: currentMonthStr, days: daysInCurMonth });
    }

    for (const item of monthsToSeed) {
        for (let day = 1; day <= item.days; day++) {
            const dateStr = `${item.month}-${String(day).padStart(2, '0')}`;
            const baseMood = 6 + Math.sin(day / 2) * 2;
            const moodNoise = Math.random() * 1.5 - 0.75;
            const mood = Math.max(1, Math.min(10, Math.round(baseMood + moodNoise)));

            const baseMotiv = 5 + Math.cos(day / 3) * 2.5;
            const motivNoise = Math.random() * 2 - 1;
            const motivation = Math.max(1, Math.min(10, Math.round(baseMotiv + motivNoise)));

            await mentalColl.insert({
                date: dateStr,
                mood: mood,
                motivation: motivation
            });
        }
    }
    console.log("Default mental states seeded successfully!");
}

async function seedDefaultTasks() {
    const tasksColl = db.collection('tasks');
    const existing = await tasksColl.find();
    if (existing.length > 0) return;

    const now = new Date();
    const dayOfWeek = now.getDay();
    const sundayDate = new Date(now);
    sundayDate.setDate(now.getDate() - dayOfWeek);
    const currentWeekStartStr = `${sundayDate.getFullYear()}-${String(sundayDate.getMonth() + 1).padStart(2, '0')}-${String(sundayDate.getDate()).padStart(2, '0')}`;

    const weeksToSeed = ["2026-01-04"];
    if (currentWeekStartStr !== "2026-01-04") {
        weeksToSeed.push(currentWeekStartStr);
    }

    for (const weekStartDate of weeksToSeed) {
        const defaultTasks = [
            { weekStartDate, dayOfWeek: 0, text: "Review the past week", completed: true, color: "#a855f7" },
            { weekStartDate, dayOfWeek: 0, text: "Plan the week ahead", completed: true, color: "#a855f7" },
            { weekStartDate, dayOfWeek: 0, text: "Grocery shopping", completed: true, color: "#a855f7" },
            { weekStartDate, dayOfWeek: 0, text: "Light home tidy", completed: true, color: "#a855f7" },
            { weekStartDate, dayOfWeek: 0, text: "Prepare meals", completed: true, color: "#a855f7" },
            { weekStartDate, dayOfWeek: 0, text: "Short walk or stretch", completed: true, color: "#a855f7" },

            { weekStartDate, dayOfWeek: 1, text: "Outline weekly goals", completed: true, color: "#3b82f6" },
            { weekStartDate, dayOfWeek: 1, text: "Check and respond to email", completed: true, color: "#3b82f6" },
            { weekStartDate, dayOfWeek: 1, text: "Start priority task", completed: true, color: "#3b82f6" },
            { weekStartDate, dayOfWeek: 1, text: "Update task tracker", completed: true, color: "#3b82f6" },
            { weekStartDate, dayOfWeek: 1, text: "Schedule the week", completed: true, color: "#3b82f6" },
            { weekStartDate, dayOfWeek: 1, text: "Focused work block", completed: true, color: "#3b82f6" },
            { weekStartDate, dayOfWeek: 1, text: "Renew gym membership", completed: false, color: "#3b82f6" },

            { weekStartDate, dayOfWeek: 2, text: "Deep work session", completed: true, color: "#14b8a6" },
            { weekStartDate, dayOfWeek: 2, text: "Draft content or ideas", completed: true, color: "#14b8a6" },
            { weekStartDate, dayOfWeek: 2, text: "Review finances", completed: true, color: "#14b8a6" },
            { weekStartDate, dayOfWeek: 2, text: "Follow up on open items", completed: true, color: "#14b8a6" },
            { weekStartDate, dayOfWeek: 2, text: "Update progress tracker", completed: true, color: "#14b8a6" },
            { weekStartDate, dayOfWeek: 2, text: "Gym or workout", completed: false, color: "#14b8a6" },

            { weekStartDate, dayOfWeek: 3, text: "Mid-week progress check", completed: true, color: "#22c55e" },
            { weekStartDate, dayOfWeek: 3, text: "Admin catch-up", completed: true, color: "#22c55e" },
            { weekStartDate, dayOfWeek: 3, text: "Improve workflow", completed: true, color: "#22c55e" },
            { weekStartDate, dayOfWeek: 3, text: "Clear downloads folder", completed: true, color: "#22c55e" },
            { weekStartDate, dayOfWeek: 3, text: "Plan tomorrow's tasks", completed: true, color: "#22c55e" },
            { weekStartDate, dayOfWeek: 3, text: "Short walk break", completed: false, color: "#22c55e" },

            { weekStartDate, dayOfWeek: 4, text: "Focused work sprint", completed: false, color: "#84cc16" },
            { weekStartDate, dayOfWeek: 4, text: "Review active projects", completed: false, color: "#84cc16" },
            { weekStartDate, dayOfWeek: 4, text: "Organise files or notes", completed: false, color: "#84cc16" },
            { weekStartDate, dayOfWeek: 4, text: "Pay any due bills", completed: false, color: "#84cc16" },
            { weekStartDate, dayOfWeek: 4, text: "Skill learning session", completed: false, color: "#84cc16" },
            { weekStartDate, dayOfWeek: 4, text: "Light workout or stretch", completed: false, color: "#84cc16" },
            { weekStartDate, dayOfWeek: 4, text: "Update dashboard logs", completed: true, color: "#84cc16" },
            { weekStartDate, dayOfWeek: 4, text: "Organize client files", completed: true, color: "#84cc16" },

            { weekStartDate, dayOfWeek: 5, text: "Finish outstanding tasks", completed: true, color: "#eab308" },
            { weekStartDate, dayOfWeek: 5, text: "Send follow-ups", completed: true, color: "#eab308" },
            { weekStartDate, dayOfWeek: 5, text: "Weekly review", completed: true, color: "#eab308" },
            { weekStartDate, dayOfWeek: 5, text: "Clean workspace", completed: false, color: "#eab308" },
            { weekStartDate, dayOfWeek: 5, text: "Log weekly progress", completed: false, color: "#eab308" },
            { weekStartDate, dayOfWeek: 5, text: "Plan next week", completed: false, color: "#eab308" },

            { weekStartDate, dayOfWeek: 6, text: "Personal project time", completed: true, color: "#f97316" },
            { weekStartDate, dayOfWeek: 6, text: "Household tasks", completed: true, color: "#f97316" },
            { weekStartDate, dayOfWeek: 6, text: "Exercise or outdoor activity", completed: true, color: "#f97316" },
            { weekStartDate, dayOfWeek: 6, text: "Reflect on the week", completed: true, color: "#f97316" },
            { weekStartDate, dayOfWeek: 6, text: "Reset workspace", completed: true, color: "#f97316" },
            { weekStartDate, dayOfWeek: 6, text: "Short walk break", completed: false, color: "#f97316" }
        ];

        for (const task of defaultTasks) {
            await tasksColl.insert(task);
        }
    }
    console.log("Default weekly tasks seeded successfully!");
}

async function seedDefaultMindsetTracker() {
    const mindsetColl = db.collection('mindset_tracker');
    const existing = await mindsetColl.find();
    if (existing.length > 0) return;

    const now = new Date();
    const dayOfWeek = now.getDay();
    const sundayDate = new Date(now);
    sundayDate.setDate(now.getDate() - dayOfWeek);
    const currentWeekStartStr = `${sundayDate.getFullYear()}-${String(sundayDate.getMonth() + 1).padStart(2, '0')}-${String(sundayDate.getDate()).padStart(2, '0')}`;

    const weeksToSeed = ["2026-01-04"];
    if (currentWeekStartStr !== "2026-01-04") {
        weeksToSeed.push(currentWeekStartStr);
    }

    for (const weekStartDate of weeksToSeed) {
        const defaultWeeklyMindset = [
            { weekStartDate, dayOfWeek: 0, energy: 7, focus: 8, motivation: 8 },
            { weekStartDate, dayOfWeek: 1, energy: 6, focus: 7, motivation: 9 },
            { weekStartDate, dayOfWeek: 2, energy: 8, focus: 8, motivation: 7 },
            { weekStartDate, dayOfWeek: 3, energy: 5, focus: 7, motivation: 8 },
            { weekStartDate, dayOfWeek: 4, energy: 7, focus: 6, motivation: 7 },
            { weekStartDate, dayOfWeek: 5, energy: 8, focus: 9, motivation: 9 },
            { weekStartDate, dayOfWeek: 6, energy: 9, focus: 8, motivation: 9 }
        ];

        for (const ms of defaultWeeklyMindset) {
            await mindsetColl.insert(ms);
        }
    }
    console.log("Default weekly mindset metrics seeded successfully!");
}

async function seedDefaultMonthlyTasks() {
    const monthlyColl = db.collection('monthly_tasks');
    const existing = await monthlyColl.find();
    if (existing.length > 0) return;

    const now = new Date();
    const curY = now.getFullYear();
    const curM = String(now.getMonth() + 1).padStart(2, '0');
    const currentMonthStr = `${curY}-${curM}`;

    const monthsToSeed = ["2026-01"];
    if (currentMonthStr !== "2026-01") {
        monthsToSeed.push(currentMonthStr);
    }

    for (const month of monthsToSeed) {
        const defaultMonthlyTasks = [
            { month, weekOfMonth: 0, text: "Define monthly main objective", completed: true },
            { month, weekOfMonth: 0, text: "Set up targets and metrics", completed: true },
            { month, weekOfMonth: 0, text: "First week check-in", completed: true },
            { month, weekOfMonth: 0, text: "Organize digital folders", completed: false },

            { month, weekOfMonth: 1, text: "Review budget & expenses", completed: true },
            { month, weekOfMonth: 1, text: "Check progress of habits", completed: true },
            { month, weekOfMonth: 1, text: "Mid-month checkpoint", completed: false },

            { month, weekOfMonth: 2, text: "Analyze energy levels trends", completed: false },
            { month, weekOfMonth: 2, text: "Optimize routine/schedule", completed: false },

            { month, weekOfMonth: 3, text: "Begin monthly evaluation", completed: false },
            { month, weekOfMonth: 3, text: "Backup critical system files", completed: false }
        ];

        for (const mt of defaultMonthlyTasks) {
            await monthlyColl.insert(mt);
        }
    }
    console.log("Default monthly tasks seeded successfully!");
}

async function seedDefaultDailyNotes() {
    const notesColl = db.collection('daily_notes');
    const existing = await notesColl.find();
    if (existing.length > 0) return;

    const today = new Date();
    const formatDate = (offsetDays) => {
        const d = new Date(today);
        d.setDate(today.getDate() - offsetDays);
        return d.toISOString().split('T')[0];
    };

    const defaultNotes = [
        {
            date: formatDate(0),
            content: "Hoje o dia foi produtivo. Foquei bastante na reestruturação do layout mobile da aplicação e consegui resolver o bug de overflow. Consegui manter a rotina de exercícios físicos também. Amanhã é manter o foco!",
            mood: "🚀",
            tags: ["produtividade", "estudos", "treino"]
        },
        {
            date: formatDate(1),
            content: "Ontem consegui ler um pouco mais antes de dormir. O sono tem melhorado bastante. Preciso beber mais água durante o dia.",
            mood: "🧘",
            tags: ["saude", "leitura", "rotina"]
        },
        {
            date: formatDate(2),
            content: "Dia focado em planejar as metas da semana. Sinto que a organização inicial ajuda muito a diminuir a ansiedade e manter a motivação.",
            mood: "🎯",
            tags: ["planejamento", "foco"]
        }
    ];

    for (const note of defaultNotes) {
        await notesColl.insert(note);
    }
    console.log("Default daily notes seeded successfully!");
}

// Initial seeding wrapper
async function runSeeding() {
    try {
        await seedDefaultHabits();
        await seedDefaultHabitEntries();
        await seedDefaultMentalState();
        await seedDefaultTasks();
        await seedDefaultMindsetTracker();
        await seedDefaultMonthlyTasks();
        await seedDefaultDailyNotes();
        console.log("Database seeding completed successfully!");
    } catch (err) {
        console.error("Database seeding failed:", err);
    }
}

// REST API Endpoints

// 1. Habits API
app.get('/api/habits', async (req, res) => {
    try {
        const habits = await db.collection('habits').find();
        res.json(habits);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/habits', async (req, res) => {
    try {
        const { name, category } = req.body;
        if (!name) return res.status(400).json({ error: 'Name is required' });
        const newHabit = await db.collection('habits').insert({ name, category: category || 'geral' });
        
        // Also create empty habit entries for January 2026 and the current month so they show up in the grid
        const entriesColl = db.collection('habit_entries');
        const now = new Date();
        const curY = now.getFullYear();
        const curM = String(now.getMonth() + 1).padStart(2, '0');
        const currentMonthStr = `${curY}-${curM}`;
        const daysInCurMonth = new Date(curY, now.getMonth() + 1, 0).getDate();
        
        const monthsToInit = ["2026-01"];
        if (currentMonthStr !== "2026-01") {
            monthsToInit.push(currentMonthStr);
        }
        
        for (const monthStr of monthsToInit) {
            const days = monthStr === "2026-01" ? 31 : daysInCurMonth;
            for (let day = 1; day <= days; day++) {
                const dateStr = `${monthStr}-${String(day).padStart(2, '0')}`;
                await entriesColl.insert({
                    date: dateStr,
                    habitId: newHabit._id,
                    completed: false
                });
            }
        }

        res.status(201).json(newHabit);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/habits/:id', async (req, res) => {
    try {
        const { name, category } = req.body;
        const updated = await db.collection('habits').update({ _id: req.params.id }, { $set: { name, category } });
        res.json({ updated });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/habits/:id', async (req, res) => {
    try {
        const id = req.params.id;
        await db.collection('habits').delete({ _id: id });
        await db.collection('habit_entries').delete({ habitId: id });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Habit Entries API
app.get('/api/habit-entries', async (req, res) => {
    try {
        const { month } = req.query; // format: 'YYYY-MM'
        const query = {};
        if (month) {
            // Custom match check in db file
            const entries = await db.collection('habit_entries').find();
            const filtered = entries.filter(e => e.date.startsWith(month));
            return res.json(filtered);
        }
        const entries = await db.collection('habit_entries').find(query);
        res.json(entries);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/habit-entries/toggle', async (req, res) => {
    try {
        const { habitId, date, completed } = req.body;
        if (!habitId || !date) return res.status(400).json({ error: 'habitId and date are required' });
        
        const entry = await db.collection('habit_entries').findOne({ habitId, date });
        if (entry) {
            await db.collection('habit_entries').update({ _id: entry._id }, { $set: { completed: !entry.completed } });
            res.json({ success: true, completed: !entry.completed });
        } else {
            const insertCompleted = (completed !== undefined) ? !!completed : true;
            const newEntry = await db.collection('habit_entries').insert({ habitId, date, completed: insertCompleted });
            res.json({ success: true, completed: newEntry.completed });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. Mental State API
app.get('/api/mental-state', async (req, res) => {
    try {
        const { month } = req.query; // format: 'YYYY-MM'
        const states = await db.collection('mental_state').find();
        if (month) {
            const filtered = states.filter(s => s.date.startsWith(month));
            return res.json(filtered);
        }
        res.json(states);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/mental-state', async (req, res) => {
    try {
        const { date, mood, motivation } = req.body;
        if (!date) return res.status(400).json({ error: 'Date is required' });

        const existing = await db.collection('mental_state').findOne({ date });
        if (existing) {
            const updateObj = {};
            if (mood !== undefined) updateObj.mood = Number(mood);
            if (motivation !== undefined) updateObj.motivation = Number(motivation);
            await db.collection('mental_state').update({ _id: existing._id }, { $set: updateObj });
            res.json({ success: true });
        } else {
            await db.collection('mental_state').insert({
                date,
                mood: mood !== undefined ? Number(mood) : 5,
                motivation: motivation !== undefined ? Number(motivation) : 5
            });
            res.json({ success: true });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/mental-state/:date', async (req, res) => {
    try {
        await db.collection('mental_state').delete({ date: req.params.date });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. Tasks API
app.get('/api/tasks', async (req, res) => {
    try {
        const { weekStartDate } = req.query;
        if (!weekStartDate) return res.status(400).json({ error: 'weekStartDate query parameter is required' });
        const tasks = await db.collection('tasks').find({ weekStartDate });
        res.json(tasks);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/tasks', async (req, res) => {
    try {
        const { weekStartDate, dayOfWeek, text, color } = req.body;
        if (!weekStartDate || dayOfWeek === undefined || !text) {
            return res.status(400).json({ error: 'weekStartDate, dayOfWeek, and text are required' });
        }
        const newTask = await db.collection('tasks').insert({
            weekStartDate,
            dayOfWeek: Number(dayOfWeek),
            text,
            completed: false,
            color: color || '#3b82f6'
        });
        res.status(201).json(newTask);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/tasks/:id', async (req, res) => {
    try {
        const { completed, text, dayOfWeek, color } = req.body;
        const updateObj = {};
        if (completed !== undefined) updateObj.completed = !!completed;
        if (text !== undefined) updateObj.text = text;
        if (dayOfWeek !== undefined) updateObj.dayOfWeek = Number(dayOfWeek);
        if (color !== undefined) updateObj.color = color;

        await db.collection('tasks').update({ _id: req.params.id }, { $set: updateObj });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/tasks/:id', async (req, res) => {
    try {
        await db.collection('tasks').delete({ _id: req.params.id });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Monthly Tasks API (weeks of the month)
app.get('/api/monthly-tasks', async (req, res) => {
    try {
        const { month } = req.query;
        if (!month) return res.status(400).json({ error: 'month query parameter is required (YYYY-MM)' });
        const tasks = await db.collection('monthly_tasks').find({ month });
        res.json(tasks);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/monthly-tasks', async (req, res) => {
    try {
        const { month, weekOfMonth, text, color } = req.body;
        if (!month || weekOfMonth === undefined || !text) {
            return res.status(400).json({ error: 'month, weekOfMonth, and text are required' });
        }
        const newTask = await db.collection('monthly_tasks').insert({
            month,
            weekOfMonth: Number(weekOfMonth),
            text,
            completed: false,
            color: color || '#3b82f6'
        });
        res.status(201).json(newTask);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/monthly-tasks/:id', async (req, res) => {
    try {
        const { completed, text, weekOfMonth, color } = req.body;
        const updateObj = {};
        if (completed !== undefined) updateObj.completed = !!completed;
        if (text !== undefined) updateObj.text = text;
        if (weekOfMonth !== undefined) updateObj.weekOfMonth = Number(weekOfMonth);
        if (color !== undefined) updateObj.color = color;

        await db.collection('monthly_tasks').update({ _id: req.params.id }, { $set: updateObj });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/monthly-tasks/:id', async (req, res) => {
    try {
        await db.collection('monthly_tasks').delete({ _id: req.params.id });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. Mindset Tracker API
app.get('/api/mindset-tracker', async (req, res) => {
    try {
        const { weekStartDate } = req.query;
        if (!weekStartDate) return res.status(400).json({ error: 'weekStartDate is required' });
        const mindset = await db.collection('mindset_tracker').find({ weekStartDate });
        res.json(mindset);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/mindset-tracker', async (req, res) => {
    try {
        const { weekStartDate, dayOfWeek, energy, focus, motivation } = req.body;
        if (!weekStartDate || dayOfWeek === undefined) {
            return res.status(400).json({ error: 'weekStartDate and dayOfWeek are required' });
        }

        const query = { weekStartDate, dayOfWeek: Number(dayOfWeek) };
        const existing = await db.collection('mindset_tracker').findOne(query);

        const updateObj = {};
        if (energy !== undefined) updateObj.energy = Number(energy);
        if (focus !== undefined) updateObj.focus = Number(focus);
        if (motivation !== undefined) updateObj.motivation = Number(motivation);

        if (existing) {
            await db.collection('mindset_tracker').update({ _id: existing._id }, { $set: updateObj });
        } else {
            await db.collection('mindset_tracker').insert({
                weekStartDate,
                dayOfWeek: Number(dayOfWeek),
                energy: energy !== undefined ? Number(energy) : 5,
                focus: focus !== undefined ? Number(focus) : 5,
                motivation: motivation !== undefined ? Number(motivation) : 5
            });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// 4. Last Fall (Relapse) Tracker API
app.get('/api/last-fall', async (req, res) => {
    try {
        const lastFallColl = db.collection('last_fall');
        const historyColl = db.collection('relapse_history');

        let active = await lastFallColl.findOne();
        if (!active) {
            // Seed a default date if none exists (e.g. Jan 1, 2026)
            active = await lastFallColl.insert({ date: new Date('2026-01-01T00:00:00.000Z').toISOString() });
        }

        const history = await historyColl.find();
        res.json({
            lastFall: active.date,
            history: history || []
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/last-fall', async (req, res) => {
    try {
        const { date } = req.body;
        if (!date) return res.status(400).json({ error: 'Date is required' });

        const lastFallColl = db.collection('last_fall');
        const historyColl = db.collection('relapse_history');

        const active = await lastFallColl.findOne();
        if (active) {
            // Save past streak to history
            const durationMs = new Date(date) - new Date(active.date);
            if (durationMs > 0) {
                await historyColl.insert({
                    startDate: active.date,
                    endDate: date,
                    durationMs
                });
            }
            await lastFallColl.update({ _id: active._id }, { $set: { date } });
        } else {
            await lastFallColl.insert({ date });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/relapse-history/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.collection('relapse_history').delete({ _id: id });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. Daily Notes API
app.get('/api/daily-notes', async (req, res) => {
    try {
        const notes = await db.collection('daily_notes').find();
        res.json(notes);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/daily-notes', async (req, res) => {
    try {
        const { date, content, mood, tags } = req.body;
        if (!date) return res.status(400).json({ error: 'Date is required' });

        const existing = await db.collection('daily_notes').findOne({ date });
        if (existing) {
            const updateObj = {};
            if (content !== undefined) updateObj.content = content;
            if (mood !== undefined) updateObj.mood = mood;
            if (tags !== undefined) updateObj.tags = tags;
            await db.collection('daily_notes').update({ _id: existing._id }, { $set: updateObj });
            res.json({ success: true });
        } else {
            await db.collection('daily_notes').insert({
                date,
                content: content || "",
                mood: mood || "",
                tags: tags || []
            });
            res.json({ success: true });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/daily-notes/:date', async (req, res) => {
    try {
        const { date } = req.params;
        await db.collection('daily_notes').delete({ date });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin Data Operations: Clear and Seed
app.post('/api/admin/clear-all', async (req, res) => {
    try {
        const fsPromises = require('fs').promises;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = path.join(__dirname, 'data', 'backup', `backup-${timestamp}`);
        await fsPromises.mkdir(backupDir, { recursive: true });

        // Copy files
        const dataPath = path.join(__dirname, 'data');
        const files = await fsPromises.readdir(dataPath);
        for (const file of files) {
            const filePath = path.join(dataPath, file);
            const stat = await fsPromises.stat(filePath);
            if (stat.isFile() && file.endsWith('.json')) {
                const destPath = path.join(backupDir, file);
                await fsPromises.copyFile(filePath, destPath);
            }
        }

        // Delete all contents in all collections
        const collectionsList = ['habits', 'habit_entries', 'mental_state', 'mental_states', 'tasks', 'mindset_tracker', 'last_fall', 'relapse_history', 'monthly_tasks', 'daily_notes'];
        for (const name of collectionsList) {
            await db.collection(name).delete({});
        }

        res.json({ success: true, backupPath: backupDir });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/seed-test-data', async (req, res) => {
    try {
        // Clear first to avoid duplicates
        const collectionsList = ['habits', 'habit_entries', 'mental_state', 'mental_states', 'tasks', 'mindset_tracker', 'last_fall', 'relapse_history', 'monthly_tasks', 'daily_notes'];
        for (const name of collectionsList) {
            await db.collection(name).delete({});
        }

        // Force running the seeding functions
        await runSeeding();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start Express server and run seeding
app.listen(PORT, async () => {
    console.log(`Server running at http://localhost:${PORT}`);
    await runSeeding();
});
