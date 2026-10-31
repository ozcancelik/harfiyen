import { useEffect, useRef, useState } from "react";
import { duration as fmtDuration } from "../lib/format";
import { projectTitle, type Project } from "../lib/projectStore";
import { IconChevron, IconEdit, IconProjects, IconTrash } from "./icons";
import { IconButton, TbLabel, toolbarButton } from "./ui";
import {
  Menu,
  MenuFoot,
  MenuGroup,
  MenuItem,
  MenuNote,
  MenuTitle,
} from "./Menu";

const when = (t: number) =>
  new Date(t).toLocaleString("tr-TR", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

function note(p: Project) {
  const parts = [(p.lang ?? "tr").toUpperCase(), when(p.updatedAt)];
  if (p.duration) parts.push(fmtDuration(p.duration));
  if (p.storage === "none") parts.push("dosya yeniden seçilir");
  return parts.join(" · ");
}

/** Saved projects, newest first, each with a delete button. */
export function ProjectList({
  projects,
  currentId,
  onOpen,
  onDelete,
  limit,
  className = "",
}: {
  projects: Project[];
  currentId?: string;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  limit?: number;
  className?: string;
}) {
  // The project whose delete button was pressed; its row asks to confirm.
  const [confirming, setConfirming] = useState<string | null>(null);
  const asking = useRef<HTMLLIElement>(null);

  // A press outside the question cancels it. Not on blur: Safari does not
  // focus a clicked button, so pressing "Sil" blurred the row (to nothing)
  // and removed the button before its click.
  useEffect(() => {
    if (!confirming) return;
    const outside = (e: PointerEvent) => {
      if (!asking.current?.contains(e.target as Node)) setConfirming(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [confirming]);

  return (
    <ul className={`m-0 grid list-none p-0 ${className}`}>
      {projects.slice(0, limit).map((p) =>
        p.id === confirming ? (
          <li
            key={p.id}
            ref={asking}
            className="flex items-center gap-2 rounded-ui-sm bg-mercan/10 py-1 pr-1 pl-2 shadow-[inset_0_0_0_1px_rgba(239,100,78,0.35)]"
            onBlur={(e) => {
              // Tab out of the question; focus going nowhere (a click in Safari) is not leaving.
              if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget))
                setConfirming(null);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              // Cancel only the question, not the menu around it.
              e.nativeEvent.stopPropagation();
              setConfirming(null);
            }}
          >
            <span className="grid min-w-0 flex-1 gap-px text-[12.5px]">
              <span className="truncate text-fg">
                “{projectTitle(p)}” silinsin mi?
              </span>
              <MenuNote>Medya dosyan diskte kalır.</MenuNote>
            </span>
            <button
              className="h-6 flex-none cursor-pointer rounded-ui-sm border-0 bg-transparent px-2 text-[12px] text-fg-2 hover:bg-line hover:text-fg"
              onClick={() => setConfirming(null)}
            >
              Vazgeç
            </button>
            <button
              className="h-6 flex-none cursor-pointer rounded-ui-sm border-0 bg-mercan px-2.5 text-[12px] font-medium text-white hover:brightness-110"
              autoFocus
              onClick={() => {
                setConfirming(null);
                onDelete(p.id);
              }}
            >
              Sil
            </button>
          </li>
        ) : (
          <li
            key={p.id}
            className="group flex items-center gap-1 rounded-ui-sm pr-1 hover:bg-line"
          >
            <button
              className="grid min-w-0 flex-1 cursor-pointer gap-px border-0 bg-transparent px-2 py-1.5 text-left text-[12.5px] text-fg"
              onClick={() => onOpen(p.id)}
              title={p.name}
            >
              <span
                className={`truncate ${p.id === currentId ? "text-firuze" : ""}`}
              >
                {projectTitle(p)}
              </span>
              <MenuNote>{note(p)}</MenuNote>
            </button>
            <IconButton
              className="flex-none opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
              onClick={() => setConfirming(p.id)}
              title="Projeyi sil"
              aria-label={`${projectTitle(p)} projesini sil`}
            >
              <IconTrash />
            </IconButton>
          </li>
        ),
      )}
    </ul>
  );
}

/** Toolbar menu: recent projects, a new project, and the project file. */
export function ProjectsMenu({
  projects,
  currentId,
  canExport,
  onOpen,
  onDelete,
  onNew,
  onExport,
  onImport,
}: {
  projects: Project[];
  currentId?: string;
  canExport: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onExport: () => void;
  onImport: () => void;
}) {
  const [open, setOpen] = useState(false);
  const act = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      align="left"
      width="w-[340px]"
      trigger={
        <button
          className={toolbarButton({ compact: true })}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          title="Projeler"
        >
          <IconProjects /> <TbLabel>Projeler</TbLabel> <IconChevron size={12} />
        </button>
      }
    >
      <MenuGroup>
        <MenuItem onClick={act(onNew)}>
          <span>Yeni proje</span>
        </MenuItem>
        <MenuItem disabled={!canExport} onClick={act(onExport)}>
          <span>Projeyi dosya olarak indir</span>
          <MenuNote>.harfiyen</MenuNote>
        </MenuItem>
        <MenuItem onClick={act(onImport)}>
          <span>Proje dosyası aç</span>
          <MenuNote>.harfiyen</MenuNote>
        </MenuItem>
      </MenuGroup>
      <MenuGroup>
        <MenuTitle>Son projeler</MenuTitle>
        {projects.length ? (
          <ProjectList
            className="max-h-[min(50vh,360px)] overflow-y-auto"
            projects={projects}
            currentId={currentId}
            onOpen={(id) => {
              setOpen(false);
              onOpen(id);
            }}
            onDelete={onDelete}
          />
        ) : (
          <MenuFoot>
            Yazıya döktüğün kayıtlar burada otomatik saklanır.
          </MenuFoot>
        )}
      </MenuGroup>
      <MenuFoot>
        Projeler yalnızca bu tarayıcıda saklanır. Medya dosyası proje dosyasına
        eklenmez.
      </MenuFoot>
    </Menu>
  );
}

/** The toolbar title; for a saved project, click to rename it. */
export function ProjectName({
  title,
  onRename,
}: {
  title: string;
  onRename?: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div
      className="min-w-0 flex-1 overflow-hidden text-center text-[12.5px] font-medium tracking-[-0.01em] text-ellipsis whitespace-nowrap text-fg-2 max-[860px]:shrink!"
      title={editing ? undefined : title}
    >
      {!onRename ? (
        title || "Yeni proje"
      ) : editing ? (
        <input
          className="w-[min(100%,320px)] rounded-ui-sm border border-line bg-bg px-2 py-0.5 text-center tracking-[inherit] text-fg outline-none select-text [font:inherit] focus:border-cini"
          defaultValue={title}
          autoFocus
          spellCheck={false}
          aria-label="Proje adı"
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            setEditing(false);
            onRename(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.currentTarget.value = title;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <button
          className="group inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-ui-sm border-0 bg-transparent py-0.75 pr-1.5 pl-2 tracking-[inherit] text-inherit [font:inherit] hover:text-fg"
          onClick={() => setEditing(true)}
          aria-label={`${title}, yeniden adlandır`}
        >
          <span className="truncate">{title}</span>
          <span className="flex flex-none opacity-0 transition-opacity duration-150 group-hover:opacity-60 group-focus-visible:opacity-60">
            <IconEdit size={12} />
          </span>
        </button>
      )}
    </div>
  );
}
