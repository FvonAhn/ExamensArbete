import Papa from 'papaparse';
import { logTraceX } from '../utils/logging';

export interface CSVRow {
  [key: string]: string | number;
}

export interface ParsedCSVResult {
  rows: CSVRow[];
  unitsByColumn: Record<string, string>;
}
const warnedDuplicateHeaderFiles = new Set<string>();

export async function detectDelimiter(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error('Failed to read file for delimiter detection'));
    };
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const firstLine = text.split('\n')[0];
        if (!firstLine) {
          resolve(','); // Default to comma
          return;
        }
        // Count semicolons and commas in first line
        const semicolonCount = (firstLine.match(/;/g) || []).length;
        const commaCount = (firstLine.match(/,/g) || []).length;
        // Use semicolon if it appears more, otherwise use comma
        resolve(semicolonCount > commaCount ? ';' : ',');
      } catch (error) {
        resolve(','); // Default to comma on error
      }
    };
    reader.readAsText(file.slice(0, 1024)); // Read first 1KB to detect delimiter
  });
}

export async function parseCSV(file: File): Promise<CSVRow[]> {
  const result = await parseCSVWithMeta(file);
  return result.rows;
}

export async function parseCSVWithMeta(file: File): Promise<ParsedCSVResult> {
  let delimiter = ',';
  try {
    delimiter = await detectDelimiter(file);
  } catch (error) {
    // If delimiter detection fails, default to comma
    console.warn('Delimiter detection failed, using comma as default:', error);
  }
  
  return new Promise((resolve, reject) => {
    Papa.parse<CSVRow>(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
      delimiter: delimiter,
      complete: (results: Papa.ParseResult<CSVRow>) => {
        const renamedHeaders = results.meta.renamedHeaders ?? {};
        const duplicateRenameCount = Object.keys(renamedHeaders).length;
        const duplicateWarningKey = `${file.name}:${file.size}:${file.lastModified}`;

        if (duplicateRenameCount > 0 && !warnedDuplicateHeaderFiles.has(duplicateWarningKey)) {
          warnedDuplicateHeaderFiles.add(duplicateWarningKey);
          console.warn(
            `CSV "${file.name}" contains ${duplicateRenameCount} duplicate header${
              duplicateRenameCount === 1 ? '' : 's'
            }. Using Papa Parse renamed columns.`,
          );
        }

        const nonDuplicateWarnings = results.errors.filter(
          (error) => error.code !== 'DuplicatedField',
        );

        if (nonDuplicateWarnings.length > 0) {
          console.warn('CSV parsing warnings:', nonDuplicateWarnings);
        }
        if (results.data.length === 0) {
          reject(new Error('CSV file is empty or has no valid data'));
          return;
        }
        
        // Get the first column name (should be "Time" or first column)
        const firstColumn = Object.keys(results.data[0])[0];
        const unitsByColumn: Record<string, string> = {};

        const firstNonNumericTimeRow = results.data.find((row) => {
          const timeValue = row[firstColumn];
          return !(typeof timeValue === 'number' && !isNaN(timeValue));
        });

        if (firstNonNumericTimeRow) {
          for (const [column, rawValue] of Object.entries(firstNonNumericTimeRow)) {
            if (!column || column === firstColumn) continue;
            if (typeof rawValue !== 'string') continue;
            const trimmed = rawValue.trim();
            if (trimmed) {
              unitsByColumn[column] = trimmed;
            }
          }
        }

        // Filter out the units row (second line) - it will have non-numeric values in the Time column
        // Also filter out any other rows where Time is not numeric
        const filteredData = results.data.filter((row) => {
          const timeValue = row[firstColumn];
          // Time column must be numeric - this will filter out the units row
          return typeof timeValue === 'number' && !isNaN(timeValue);
        });

        if (filteredData.length === 0) {
          reject(new Error('CSV file contains no valid numeric data'));
          return;
        }

        resolve({
          rows: filteredData,
          unitsByColumn,
        });
      },
      error: (error: Error) => {
        reject(new Error(`Failed to parse CSV: ${error.message}`));
      },
    });
  });
}

