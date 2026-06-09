/**
 * Discriminated-union Member type.
 *
 * Currently only BeamMember is implemented. When column or wall design is added,
 * import the new member type here and add it to the union.
 *
 * TypeScript narrows the union automatically:
 *   if (member.memberType === 'column') { // member is ColumnMember here }
 */

import type { BeamMember } from './beam';
// import type { ColumnMember } from './column';  // uncomment when implemented
// import type { WallMember }   from './wall';    // uncomment when implemented

/** All concrete member types currently supported. */
export type Member = BeamMember;
// export type Member = BeamMember | ColumnMember | WallMember;

/** Union of all memberType literals. Extend as new engines are added. */
export type MemberType = Member['memberType'];
// When columns/walls are added this automatically becomes 'beam' | 'column' | 'wall'
