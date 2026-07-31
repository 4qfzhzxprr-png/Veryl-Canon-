import { createBenefitsApi } from './api.js';
import { BenefitsStore } from './store.js';

const port = Number(process.env.PORT ?? 3200);

const server = createBenefitsApi(new BenefitsStore());

server.listen(port, () => {
  console.log(
    `Benefits Administration (stub) listening on :${port} — state is in-memory and disposable; seed it through /admin`,
  );
});
