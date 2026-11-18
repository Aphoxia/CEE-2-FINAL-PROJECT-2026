export const clubDepartments = [
  ['BOARD', 'Board'],
  ['PR', 'PR'],
  ['IT', 'IT & Tech support'],
  ['LOCATION', 'Location'],
  ['WORKSHOPS', 'Workshops'],
  ['SECRETARIAT', 'Secretariat'],
  ['FINANCE', 'Finance'],
  ['WELLFARE', 'Wellfare'],
  ['OPERATIONS', 'Operation'],
] as const;

export function departmentLabel(id: string) {
  if (id === 'MEMBER_RELATIONS') return 'Member Relations (เดิม)';
  return clubDepartments.find(([departmentId]) => departmentId === id)?.[1] ?? id;
}
