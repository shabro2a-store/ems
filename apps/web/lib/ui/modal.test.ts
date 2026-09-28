// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { Modal } from '@/components/ui/Modal';

/*
 * #54: the dialog had role="dialog" and nothing else a keyboard or a screen
 * reader needs - focus stayed on the page behind it, Tab walked out of it
 * into the page, closing it dropped focus on the body, and it had no name.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function Harness() {
  const [open, setOpen] = useState(false);
  return createElement(
    'div',
    null,
    createElement('button', { id: 'opener', onClick: () => setOpen(true) }, 'Open'),
    open &&
      // Modal's props type requires children, so they go in the props object.
      // eslint-disable-next-line react/no-children-prop
      createElement(Modal, {
        title: 'Edit branch',
        onClose: () => setOpen(false),
        children: [createElement('input', { id: 'first', key: 'f' }), createElement('button', { id: 'last', key: 'l' }, 'Save')],
      }),
  );
}

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Harness)));
  const opener = document.getElementById('opener') as HTMLButtonElement;
  opener.focus();
  await act(async () => opener.click());
  return opener;
}

const tab = (shift = false) =>
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }));

describe('a dialog', () => {
  it('is named by its title', async () => {
    await mount();
    const dialog = document.querySelector('[role="dialog"]')!;
    const label = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '');
    expect(label?.textContent).toBe('Edit branch');
  });

  it('takes the focus when it opens', async () => {
    await mount();
    expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true);
  });

  it('keeps Tab inside it, both ways', async () => {
    await mount();
    const dialog = document.querySelector('[role="dialog"]')!;
    const focusables = dialog.querySelectorAll<HTMLElement>('button, input');
    focusables[focusables.length - 1]!.focus();
    await act(async () => void tab());
    expect(document.activeElement).toBe(focusables[0]);
    await act(async () => void tab(true));
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);
  });

  it('gives the focus back to what opened it when it closes', async () => {
    const opener = await mount();
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
