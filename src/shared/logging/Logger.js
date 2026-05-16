const noop = () => {};

export function createLogger(logger = console) {
  return {
    debug: logger.debug?.bind(logger) ?? noop,
    info: logger.info?.bind(logger) ?? logger.log?.bind(logger) ?? noop,
    warn: logger.warn?.bind(logger) ?? noop,
    error: logger.error?.bind(logger) ?? noop,
  };
}
