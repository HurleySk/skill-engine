'use strict';

const handlers = new Map();

function register(handlerDef) {
  if (!handlerDef || !handlerDef.name) throw new Error('Handler must have a name');
  if (typeof handlerDef.validate !== 'function') throw new Error('Handler must have a validate function');
  if (typeof handlerDef.execute !== 'function') throw new Error('Handler must have an execute function');
  if (handlers.has(handlerDef.name)) throw new Error('Handler type already registered: ' + handlerDef.name);
  handlers.set(handlerDef.name, handlerDef);
}

function get(typeName) {
  return handlers.get(typeName);
}

function list() {
  return Array.from(handlers.keys());
}

function validateAsyncBlock(asyncBlock) {
  if (!asyncBlock || !asyncBlock.handler) return ['Missing async.handler field'];
  const handler = handlers.get(asyncBlock.handler);
  if (!handler) return ['Unknown async handler type: ' + asyncBlock.handler];
  return handler.validate(asyncBlock.config || {});
}

function normalizeAsyncBlock(asyncBlock) {
  if (asyncBlock.handler) return asyncBlock;
  if (asyncBlock.analyzer) {
    return {
      handler: 'analyzer',
      name: asyncBlock.analyzer,
      config: asyncBlock.config || {},
    };
  }
  return asyncBlock;
}

function clear() {
  handlers.clear();
}

module.exports = { register, get, list, validateAsyncBlock, normalizeAsyncBlock, clear };
