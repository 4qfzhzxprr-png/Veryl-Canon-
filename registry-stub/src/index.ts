import { createRegistryApi } from './api.js';
import { RegistryStore } from './store.js';

const port = Number(process.env.PORT ?? 3100);

const server = createRegistryApi(new RegistryStore());

server.listen(port, () => {
  console.log(`Veryl Agent Registry (stub) listening on :${port} — state is in-memory and disposable`);
});
