// Мінімальний CSV з лапками: достатньо для синтетичних наборів цього репо.

/** Розбирає один рядок CSV з лапками ("…", "" всередині — це одна лапка). */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (quoted) throw new Error("незакрита лапка");
  cells.push(cell);
  return cells;
}

/** Текст CSV → масив об'єктів за заголовком; кидає помилку з номером рядка, якщо формат зламано. */
export function parseTable<const C extends readonly string[]>(text: string, columns: C): Record<C[number], string>[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new Error("порожній файл");
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  if (header.join(",") !== columns.join(",")) {
    throw new Error(`очікувано заголовок ${columns.join(",")}, отримано ${header.join(",")}`);
  }
  return lines.slice(1).map((line, i) => {
    const lineNo = i + 2;
    let cells: string[];
    try {
      cells = parseCsvLine(line);
    } catch (e) {
      throw new Error(`рядок ${lineNo}: ${(e as Error).message}`);
    }
    if (cells.length !== columns.length) {
      throw new Error(`рядок ${lineNo}: ${cells.length} колонок замість ${columns.length}`);
    }
    return Object.fromEntries(columns.map((c, k) => [c, cells[k].trim()])) as Record<C[number], string>;
  });
}
