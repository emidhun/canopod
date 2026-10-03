import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import FilesPage from "./FilesPage";
import { MOCK } from "../mocks";
import type { FileCardT } from "../provision";
import type { PageProps } from "../types";
const initial: FileCardT[] = [{ id: 'first', path: '.env', format: 'dotenv', from: '.env', interpolate: false, keys: [{ id: 'key', k: 'PORT', v: '3000' }] }, { id: 'second', path: 'config/app.json', format: 'json', from: '', interpolate: false, keys: [] }];
function Editor({ dirty = vi.fn(), flash = vi.fn() }: { dirty?: ReturnType<typeof vi.fn>; flash?: ReturnType<typeof vi.fn> }) {
  const [cards,setCards] = useState(initial), [extras,setExtras] = useState({ migrate: [], teardown: [] } as { migrate: string[]; teardown: string[] });
  return <FilesPage {...({ repo: MOCK.repos[0], cards, setCards, extras, setExtras, markDirty: dirty, flash } as unknown as PageProps)} />;
}
it("selects a file, retains its edits, duplicates independently and recovers selection after removal", async () => {
  const user = userEvent.setup(), dirty = vi.fn(); render(<Editor dirty={dirty} />);
  await user.click(screen.getByRole('button', { name: /config\/app.json.*json/ }));
  expect(screen.getByLabelText('Destination path')).toHaveValue('config/app.json');
  await user.type(screen.getByLabelText('Source template'), 'templates/app.json');
  await user.click(screen.getByRole('button', { name: 'Duplicate config/app.json' }));
  expect(screen.getByLabelText('Destination path')).toHaveValue('config/app.json.copy');
  await user.clear(screen.getByLabelText('Source template')); await user.type(screen.getByLabelText('Source template'), 'other.json');
  await user.click(screen.getByRole('button', { name: /^config\/app.jsonjson/ }));
  expect(screen.getByLabelText('Source template')).toHaveValue('templates/app.json');
  await user.click(screen.getByRole('button', { name: 'Remove config/app.json' }));
  expect(screen.getByLabelText('Destination path')).toHaveValue('.env'); expect(dirty).toHaveBeenCalledWith('files');
  expect(document.querySelector('button button')).toBeNull();
});
it("adds and removes files through the empty state", async () => {
  const user = userEvent.setup(); render(<Editor />);
  await user.click(screen.getByRole('button', { name: 'Remove .env' })); await user.click(screen.getByRole('button', { name: 'Remove config/app.json' }));
  expect(screen.queryByRole('region', { name: 'File configuration' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Add file' })); expect(screen.getByLabelText('Destination path')).toHaveValue(''); expect(screen.getByLabelText('Format')).toHaveValue('dotenv');
});
it("keeps key values when changing format and switches text files to interpolation controls", async () => {
  const user = userEvent.setup(); render(<Editor />);
  await user.selectOptions(screen.getByLabelText('Format'), 'text'); expect(screen.queryByLabelText('Key')).not.toBeInTheDocument();
  await user.click(screen.getByRole('switch', { name: 'Interpolate template variables' })); expect(screen.getByRole('switch')).toHaveAttribute('aria-checked','true');
  await user.selectOptions(screen.getByLabelText('Format'), 'json'); expect(screen.getByLabelText('Key')).toHaveValue('PORT'); expect(screen.getByLabelText('Value')).toHaveValue('3000');
  await user.click(screen.getByRole('button', { name: 'Add key' })); expect(screen.getAllByLabelText('Key')).toHaveLength(2);
  await user.click(screen.getByRole('button', { name: 'Remove key PORT' })); expect(screen.getAllByLabelText('Key')).toHaveLength(1);
});
it("records lifecycle commands as separate ordered lines", async () => {
  const user = userEvent.setup(), dirty = vi.fn(); render(<Editor dirty={dirty} />);
  await user.type(screen.getByLabelText('migrate commands'), 'pnpm migrate\npnpm seed'); await user.type(screen.getByLabelText('teardown commands'), 'dropdb test');
  expect(screen.getByLabelText('migrate commands')).toHaveValue('pnpm migrate\npnpm seed'); expect(screen.getByLabelText('teardown commands')).toHaveValue('dropdb test'); expect(dirty).toHaveBeenCalledWith('files');
});

it('inserts a variable only into the focused key and clears that target when changing files',async()=>{
 const user=userEvent.setup(),flash=vi.fn();render(<Editor flash={flash}/>);
 const pick=async()=>{await user.click(screen.getByRole('button',{name:/Insert variable/}));await user.click(screen.getByRole('button',{name:/INT_DB_NAME/}));};
 await user.click(screen.getByLabelText('Value'));await pick();expect(screen.getByLabelText('Value')).toHaveValue('3000${INT_DB_NAME}');
 await user.click(screen.getByRole('button',{name:/^config\/app.jsonjson/}));await pick();expect(flash).toHaveBeenCalledWith('Select a value field first, then insert');
 await user.click(screen.getByRole('button',{name:/^\.envdotenv/}));expect(screen.getByLabelText('Value')).toHaveValue('3000${INT_DB_NAME}');
});
it('closes the variable picker on Escape and restores its trigger focus',async()=>{
 const user=userEvent.setup();render(<Editor/>);const trigger=screen.getByRole('button',{name:/Insert variable/});await user.click(trigger);expect(screen.getByRole('dialog',{name:'Template variables'})).toBeInTheDocument();await user.keyboard('{Escape}');expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(trigger).toHaveFocus();
});
