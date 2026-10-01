// The group membership, role and ownership mutations of
// docs/13-contratos-funcoes.md section 5 delivered by docs/25-plano-m2.md
// section 4. The gateway itself lives in ../_shared/edge-gateway.ts.

import { serveGateway } from '../_shared/edge-gateway.ts';
import { GROUP_OPERATIONS } from '../_shared/operations.ts';
import { INVITE_OPERATIONS } from '../_shared/invite-gateway.ts';

serveGateway([...GROUP_OPERATIONS, ...INVITE_OPERATIONS]);
