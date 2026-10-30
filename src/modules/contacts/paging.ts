import { col, Op, where, type WhereOptions } from 'sequelize';
import { ValidationError } from '../../lib/errors.js';

export type ListSort = 'name' | 'updated';

/** Where the previous page stopped: the sort value and id of its last row. */
interface Cursor {
  sort: ListSort;
  value: string;
  id: string;
}

export const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decodeCursor(text: string, sort: ListSort): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (
      parsed.sort === sort &&
      typeof parsed.value === 'string' &&
      typeof parsed.id === 'string' &&
      (sort === 'name' || !Number.isNaN(Date.parse(parsed.value)))
    ) {
      return { sort, value: parsed.value, id: parsed.id };
    }
  } catch {
    // Falls through to the error below.
  }
  throw new ValidationError('This page link is not valid. Reload the list.');
}

/**
 * Order and "after the cursor" condition for a list of `alias` rows: by name (A to Z, then id) or
 * by last update (newest first, then id). `sort_name` is the table's lower(name) column.
 */
export function paging(alias: string, sort: ListSort, cursor: string | undefined) {
  const sortName = col(`${alias}.sort_name`);
  const order: [ReturnType<typeof col> | string, string][] =
    sort === 'name'
      ? [
          [sortName, 'ASC'],
          ['id', 'ASC'],
        ]
      : [
          ['updatedAt', 'DESC'],
          ['id', 'DESC'],
        ];
  let after: WhereOptions | null = null;
  if (cursor) {
    const { value, id } = decodeCursor(cursor, sort);
    after =
      sort === 'name'
        ? {
            [Op.or]: [
              where(sortName, Op.gt, value),
              { [Op.and]: [where(sortName, Op.eq, value), { id: { [Op.gt]: id } }] },
            ],
          }
        : {
            [Op.or]: [
              { updatedAt: { [Op.lt]: new Date(value) } },
              { updatedAt: new Date(value), id: { [Op.lt]: id } },
            ],
          };
  }
  return { order, after };
}

/** Escapes LIKE wildcards so a search for "50%" means the text "50%". */
export const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
