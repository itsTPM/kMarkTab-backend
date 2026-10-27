export type Fields = Record<string, unknown>;

export interface Log {
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
}

// One JSON object per line, for whatever collects the process output
export const consoleLog: Log = {
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields),
};

function write(level: string, message: string, fields?: Fields) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields });
  if (level === "info") {
    console.log(line);
  } else {
    console.error(line);
  }
}

export const silentLog: Log = { info() {}, warn() {}, error() {} };
