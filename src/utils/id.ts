/**
 * ID 生成工具
 */

import { v4 as uuidv4 } from 'uuid';

export function makeId(prefix = 'id'): string {
  return `${prefix}_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
}
