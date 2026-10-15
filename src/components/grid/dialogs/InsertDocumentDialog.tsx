/**
 * Write a MongoDB document by hand and insert it.
 *
 * The gap this closes: a collection is schemaless, but every insert path the
 * app had was shaped like a SQL row. The draft row (and its list-view twin,
 * `DraftDocumentCard`) iterates the *columns the grid discovered*, which are
 * sampled from one page of documents — a description of what those documents
 * happened to contain, not of what a document may contain. A field the sample
 * did not show could not be typed at all. The only way to insert an arbitrary
 * document was "Import JSON", which opens a file picker: fine for a bulk load,
 * absurd for adding one record.
 *
 * So the two paths are complementary and both stay. The draft row is faster
 * when the shape is already right, which is the common case; this is for when
 * it is not.
 *
 * **The frontend does not parse what is typed here.** The text crosses the IPC
 * boundary as source and is read by `shell::parse_relaxed_value`, the same Rust
 * parser the query editor and the aggregation builder use (ADR #33). That is
 * what lets a document pasted out of a shell session — `ObjectId(…)`,
 * `ISODate(…)`, `NumberLong(…)`, unquoted keys, single quotes, trailing commas,
 * comments — mean here exactly what it means everywhere else. A `JSON.parse`
 * here would reject most of that outright and, worse, would quietly narrow a
 * `NumberLong` that fits in an `Int32` (ADR #29's trap).
 *
 * `PipelineEditor` rather than the JSON cell editor for the same reason: it
 * renders the `mongodb-pipeline` language, whose Monarch grammar knows those
 * constructors and whose completions offer them. A `json`-mode editor would
 * red-squiggle every valid `ObjectId(…)` in the box. Its `completion` entry is
 * pointed at this collection, so the field names already in it are suggested
 * while typing — the closest thing a schemaless store has to a column list.
 *
 * An array of documents is accepted too, and inserted with `insert_many`.
 * That falls out of the parser accepting one, and it is what makes pasting the
 * output of a `find()` work.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialogActions } from "@/components/ui/dialog-actions";
import { PipelineEditor } from "@/components/aggregation/PipelineEditor";
import type { MongoCompletionEntry } from "@/lib/monaco/monacoMongo";
import { useAsyncSubmit } from "@/lib/useAsyncSubmit";
import { api } from "@/lib/tauri";

/** What a fresh dialog starts with: an empty document, caret between the
 *  braces. Not a sampled skeleton of the collection's fields — that would be
 *  the draft row's job, done worse, and it would put a wrong `_id` in front of
 *  someone who only wanted to paste. */
const INITIAL_SOURCE = "{\n  \n}";

export function InsertDocumentDialog({
  open,
  onOpenChange,
  connectionId,
  collection,
  completion,
  onInserted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  /** Collection to insert into. Shown in the title — a dialog that writes to
   *  a database says which one. */
  collection: string;
  /** Field suggestions for this collection, if the caller has them. */
  completion?: MongoCompletionEntry;
  /** Refresh the grid. Called only after the insert resolves. */
  onInserted: () => void;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState(INITIAL_SOURCE);
  const { submitting, error, run, clearError } = useAsyncSubmit();

  // Reset on *open* rather than on close, so a failed insert keeps the text on
  // screen while the error is read — and so reopening never shows the last
  // attempt's leftovers.
  useEffect(() => {
    if (open) {
      setSource(INITIAL_SOURCE);
      clearError();
    }
  }, [open, clearError]);

  function submit() {
    if (!source.trim()) return;
    run(async () => {
      await api.insertDocuments({ connectionId, collection, source });
      onInserted();
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent tier="panel" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("dataGrid.insertDocument.title", { collection })}
          </DialogTitle>
          <DialogDescription>
            {t("dataGrid.insertDocument.hint")}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {/* `height={280}` is explicit, not `flex-1`: Monaco sizes itself in
              pixels, and a flex-stretched box inside the `panel` tier's
              scrolling body would hand it a height that isn't settled until
              layout, which Monaco does not react to on its own. */}
          <div className="overflow-hidden rounded-md border border-border">
            <PipelineEditor
              value={source}
              onChange={setSource}
              // Ctrl+Enter commits, matching every other editor in the app.
              onRun={submit}
              height={280}
              lineNumbers
              completion={completion}
            />
          </div>

          {/* Above the footer, not in a toast: a rejected document is almost
              always a parse error naming a position, and it has to be readable
              next to the text it is about. The dialog stays open with the source
              intact so it can be fixed in place. */}
          {error && (
            <div className="mt-3 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-xs text-destructive">
              {t("dataGrid.insertDocument.failed", { message: error })}
            </div>
          )}
        </DialogBody>
        <DialogActions
          onCancel={() => onOpenChange(false)}
          cancelLabel={t("common.cancel")}
          onConfirm={submit}
          confirmLabel={
            submitting
              ? t("dataGrid.insertDocument.inserting")
              : t("dataGrid.insertDocument.confirm")
          }
          confirmDisabled={submitting || !source.trim()}
        />
      </DialogContent>
    </Dialog>
  );
}
