import { createApi } from './api.js';
import { openDb } from './db.js';
import { CanonStore } from './store.js';

const dbPath = process.env.CANON_DB ?? 'canon.db';
const port = Number(process.env.PORT ?? 3000);

const store = new CanonStore(openDb(dbPath));
const server = createApi(store);

server.listen(port, () => {
  console.log(`Veryl Canon (alpha) listening on :${port}, record at ${dbPath}`);
});
