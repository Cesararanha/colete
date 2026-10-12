import { z } from 'zod';

// Every frontend schema imports this dependency before calling a Zod builder.
// CSP forbids eval, including the caught JIT capability probe.
z.config({ jitless: true });

export { z };
