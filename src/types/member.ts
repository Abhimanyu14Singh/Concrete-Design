/**
 * Discriminated-union Member type (experimental — the app uses the flat Member
 * interface in ./index.ts). Kept for the structured per-type modelling.
 *
 * TypeScript narrows the union automatically:
 *   if (member.memberType === 'column') { // member is ColumnMember here }
 */

import type { BeamMember } from './beam';
// import type { ColumnMember } from './column';  // uncomment when implemented

/** All concrete member types currently supported. */
export type Member = BeamMember;
// export type Member = BeamMember | ColumnMember;

/** Union of all memberType literals. Extend as new engines are added. */
export type MemberType = Member['memberType'];
