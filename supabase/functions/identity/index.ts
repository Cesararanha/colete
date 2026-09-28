// The identity and privacy mutations of docs/13-contratos-funcoes.md sections
// 5.2 to 5.7. The gateway itself lives in ../_shared/edge-gateway.ts.

import { serveGateway } from '../_shared/edge-gateway.ts';
import { IDENTITY_OPERATIONS } from '../_shared/operations.ts';

serveGateway(IDENTITY_OPERATIONS);
