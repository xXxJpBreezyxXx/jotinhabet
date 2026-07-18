import { describe, it, expect } from 'vitest';
import { extrairJsonDeLLM } from '../../src/IA/jsonUtils';

describe('extrairJsonDeLLM', () => {
  it('parseia JSON puro', () => {
    expect(extrairJsonDeLLM('{"a":1}')).toEqual({ a: 1 });
  });

  it('remove cercas de markdown', () => {
    expect(extrairJsonDeLLM('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('isola o objeto com texto ao redor', () => {
    expect(extrairJsonDeLLM('Claro! Aqui está: {"a":{"b":2}} espero ter ajudado')).toEqual({ a: { b: 2 } });
  });

  it('retorna null para JSON quebrado', () => {
    expect(extrairJsonDeLLM('{"a": deu ruim')).toBeNull();
  });

  it('retorna null sem JSON algum', () => {
    expect(extrairJsonDeLLM('não achei nada na imagem')).toBeNull();
  });

  it('retorna null para entrada vazia', () => {
    expect(extrairJsonDeLLM('')).toBeNull();
  });
});
