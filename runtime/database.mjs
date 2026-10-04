import { readFile } from 'node:fs/promises';
import pg from 'pg';

export async function openDatabase(statePath) {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const port = state.ports?.service;
  if (!Number.isInteger(port) || port < 1) throw new Error('Start PostgreSQL through Lasso before the Todo app.');
  const pool = new pg.Pool({ host: '127.0.0.1', port, database: 'postgres', user: 'pgadmin', password: 'pgadmin', connectionTimeoutMillis: 5000 });
  pool.on('error', () => console.error('PostgreSQL unavailable. Check its service in Admin.'));
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      await pool.query('CREATE TABLE IF NOT EXISTS tutorial_todos (id text PRIMARY KEY, title text NOT NULL)');
      ready = true; break;
    } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  if (!ready) { await pool.end(); throw new Error('PostgreSQL did not become ready. Inspect its logs.'); }
  return {
    seed: async todos => { for (const todo of todos) await pool.query('INSERT INTO tutorial_todos (id, title) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [todo.id, todo.title]); },
    list: async () => (await pool.query('SELECT id, title FROM tutorial_todos ORDER BY id')).rows,
    add: async todo => { await pool.query('INSERT INTO tutorial_todos (id, title) VALUES ($1, $2)', [todo.id, todo.title]); },
    health: async () => { await pool.query('SELECT 1'); },
    close: () => pool.end()
  };
}
