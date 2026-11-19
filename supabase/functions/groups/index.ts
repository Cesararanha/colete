// The group membership, role and ownership mutations of
// docs/13-contratos-funcoes.md section 5 delivered by docs/25-plano-m2.md
// section 4. The gateway itself lives in ../_shared/edge-gateway.ts.

import { serveGateway } from '../_shared/edge-gateway.ts';
import { GROUP_OPERATIONS } from '../_shared/operations.ts';
import { INVITE_OPERATIONS } from '../_shared/invite-gateway.ts';
import { MATCH_READ_OPERATIONS } from '../_shared/match-reads.ts';
import { GEOCODE_OPERATIONS } from '../_shared/geocode.ts';
import { PHOTO_OPERATIONS } from '../_shared/photo-gateway.ts';
import { RATING_READ_OPERATIONS } from '../_shared/rating-reads.ts';
import { PIX_READ_OPERATIONS } from '../_shared/pix-reads.ts';

serveGateway([
  ...GROUP_OPERATIONS,
  ...INVITE_OPERATIONS,
  ...MATCH_READ_OPERATIONS,
  ...GEOCODE_OPERATIONS,
  ...PHOTO_OPERATIONS,
  ...RATING_READ_OPERATIONS,
  ...PIX_READ_OPERATIONS,
]);
