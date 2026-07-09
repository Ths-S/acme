-- ============================================================
-- POSTADOR / HABIT DASHBOARD — SUPABASE SCHEMA SETUP
-- Run this entire script in Supabase SQL Editor (supabase.com)
-- Dashboard → SQL Editor → New Query → Paste → Run
-- ============================================================

-- 1. HABITS (list of habit definitions)
CREATE TABLE IF NOT EXISTS habits (
    _id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'geral',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. HABIT ENTRIES (daily check-ins per habit)
CREATE TABLE IF NOT EXISTS habit_entries (
    _id TEXT PRIMARY KEY,
    "habitId" TEXT NOT NULL,
    date TEXT NOT NULL,
    completed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. MENTAL STATE (daily mood/motivation scores)
CREATE TABLE IF NOT EXISTS mental_state (
    _id TEXT PRIMARY KEY,
    date TEXT NOT NULL UNIQUE,
    mood NUMERIC DEFAULT 5,
    motivation NUMERIC DEFAULT 5,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. TASKS (weekly tasks)
CREATE TABLE IF NOT EXISTS tasks (
    _id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    "weekStartDate" TEXT NOT NULL,
    "dayOfWeek" INTEGER DEFAULT 0,
    completed BOOLEAN DEFAULT FALSE,
    color TEXT DEFAULT '#3b82f6',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. MONTHLY TASKS
CREATE TABLE IF NOT EXISTS monthly_tasks (
    _id TEXT PRIMARY KEY,
    month TEXT NOT NULL,
    "weekOfMonth" INTEGER DEFAULT 0,
    text TEXT NOT NULL,
    completed BOOLEAN DEFAULT FALSE,
    color TEXT DEFAULT '#3b82f6',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. MINDSET TRACKER (weekly energy/focus/motivation sliders)
CREATE TABLE IF NOT EXISTS mindset_tracker (
    _id TEXT PRIMARY KEY,
    "weekStartDate" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    energy NUMERIC DEFAULT 5,
    focus NUMERIC DEFAULT 5,
    motivation NUMERIC DEFAULT 5,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. LAST FALL (sobriety tracker — current streak start date)
CREATE TABLE IF NOT EXISTS last_fall (
    _id TEXT PRIMARY KEY,
    date TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. RELAPSE HISTORY (past sobriety streak records)
CREATE TABLE IF NOT EXISTS relapse_history (
    _id TEXT PRIMARY KEY,
    "startDate" TIMESTAMPTZ NOT NULL,
    "endDate" TIMESTAMPTZ NOT NULL,
    "durationMs" BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. DAILY NOTES
CREATE TABLE IF NOT EXISTS daily_notes (
    _id TEXT PRIMARY KEY,
    date TEXT NOT NULL UNIQUE,
    content TEXT DEFAULT '',
    mood TEXT DEFAULT '',
    tags TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- DISABLE ROW LEVEL SECURITY (personal app, no user auth)
-- This allows the anon key to read/write all tables freely.
-- ============================================================
ALTER TABLE habits DISABLE ROW LEVEL SECURITY;
ALTER TABLE habit_entries DISABLE ROW LEVEL SECURITY;
ALTER TABLE mental_state DISABLE ROW LEVEL SECURITY;
ALTER TABLE tasks DISABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_tasks DISABLE ROW LEVEL SECURITY;
ALTER TABLE mindset_tracker DISABLE ROW LEVEL SECURITY;
ALTER TABLE last_fall DISABLE ROW LEVEL SECURITY;
ALTER TABLE relapse_history DISABLE ROW LEVEL SECURITY;
ALTER TABLE daily_notes DISABLE ROW LEVEL SECURITY;

-- ============================================================
-- GRANT full access to anon and authenticated roles
-- ============================================================
GRANT ALL ON habits TO anon, authenticated;
GRANT ALL ON habit_entries TO anon, authenticated;
GRANT ALL ON mental_state TO anon, authenticated;
GRANT ALL ON tasks TO anon, authenticated;
GRANT ALL ON monthly_tasks TO anon, authenticated;
GRANT ALL ON mindset_tracker TO anon, authenticated;
GRANT ALL ON last_fall TO anon, authenticated;
GRANT ALL ON relapse_history TO anon, authenticated;
GRANT ALL ON daily_notes TO anon, authenticated;

-- Done! All 9 tables created and accessible.
