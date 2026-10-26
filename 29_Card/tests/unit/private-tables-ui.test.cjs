/** @jest-environment jsdom */
const { describe, test, expect, afterEach } = require('@jest/globals');
require('@testing-library/jest-dom');
const React = require('react');
const { render, screen, fireEvent, cleanup, waitFor } = require('@testing-library/react');
const { PrivateTables } = require('../../src/client/PrivateTables.tsx');

const originalFetch = global.fetch;
afterEach(() => { cleanup(); global.fetch = originalFetch; });
function open() {
  const onJoin = jest.fn();
  render(React.createElement(PrivateTables, { onJoin }));
  fireEvent.click(screen.getByRole('button', { name: 'Private table' }));
  return onJoin;
}
describe('PIN private table entry', () => {
  test('creates a table and passes invisible seat credentials to the connection', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ pin: '012345', token: 'S'.repeat(43) }) });
    const joined = open();
    fireEvent.click(screen.getByRole('button', { name: 'Create table' }));
    await waitFor(() => expect(joined).toHaveBeenCalledWith(expect.objectContaining({ pin: '012345', token: 'S'.repeat(43) })));
    expect(global.fetch.mock.calls[0][0].pathname).toBe('/29-card/tables');
    expect(global.fetch.mock.calls[0][1].body).toBe('{}');
    expect(screen.queryByText('S'.repeat(43))).not.toBeInTheDocument();
  });
  test('joins using exactly six digits including a leading zero', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ pin: '012345', token: 'S'.repeat(43) }) });
    const joined = open();
    fireEvent.click(screen.getByRole('button', { name: 'Join table' }));
    fireEvent.change(screen.getByLabelText('Six-digit PIN'), { target: { value: '012345' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Join table' }).closest('form'));
    await waitFor(() => expect(joined).toHaveBeenCalledTimes(1));
    expect(global.fetch.mock.calls[0][1].body).toBe('{"pin":"012345"}');
    expect(global.fetch.mock.calls[0][0].pathname).toBe('/29-card/tables/join');
  });
  test.each(['12345', 'abcdef', '1234567'])('rejects invalid PIN %s without making a request', value => {
    global.fetch = jest.fn(); open();
    fireEvent.click(screen.getByRole('button', { name: 'Join table' }));
    fireEvent.change(screen.getByLabelText('Six-digit PIN'), { target: { value } });
    fireEvent.submit(screen.getByRole('button', { name: 'Join table' }).closest('form'));
    expect(screen.getByRole('alert')).toHaveTextContent('exactly six digits');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  test.each([[404, 'not found'], [409, 'full'], [429, 'Too many attempts'], [503, 'temporarily unavailable']])('shows safe errors for status %s', async (status, message) => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status });
    const joined = open();
    fireEvent.click(screen.getByRole('button', { name: 'Create table' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(joined).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create table' })).toBeEnabled();
  });
  test('rejects malformed responses and recovers from network failures', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ pin: 'oops', token: 'short' }) })
      .mockRejectedValueOnce(new Error('private server detail'));
    const joined = open();
    fireEvent.click(screen.getByRole('button', { name: 'Create table' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid response');
    fireEvent.click(screen.getByRole('button', { name: 'Create table' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach');
    expect(screen.getByRole('alert')).not.toHaveTextContent('private server detail');
    expect(joined).not.toHaveBeenCalled();
  });
  test('prevents duplicate create requests while waiting', () => {
    global.fetch = jest.fn().mockReturnValue(new Promise(() => {})); open();
    fireEvent.click(screen.getByRole('button', { name: 'Create table' }));
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  test('rejects insecure remote server addresses before sending a PIN', () => {
    global.fetch = jest.fn(); open();
    fireEvent.change(screen.getByLabelText('Table WebSocket address'), { target: { value: 'ws://example.com/29-card/ws' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create table' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Remote tables require WSS');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  test('rejects a successful join response for a different table', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ pin: '654321', token: 'S'.repeat(43) }) });
    const joined = open();
    fireEvent.click(screen.getByRole('button', { name: 'Join table' }));
    fireEvent.change(screen.getByLabelText('Six-digit PIN'), { target: { value: '123456' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Join table' }).closest('form'));
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid response');
    expect(joined).not.toHaveBeenCalled();
  });
});
