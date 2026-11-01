// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The Profile page from fixed, made-up answers: no DOM, no network.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { client, type Fetch } from "../src/web/data/api.ts";
import {
  PROFILE_PATH,
  type ProfileAnswer,
  profileStore,
  RESTORE_STALE,
  STALE,
} from "../src/web/data/profile.ts";
import { store as appStore, SESSION_PATH } from "../src/web/data/store.ts";
import {
  authorWords,
  kb,
  latest,
  lines,
  MAX_BYTES,
  OUTLINE,
  type Picked,
  sizeOf,
  TOOLS,
  typed,
  wrap,
} from "../src/web/views/Profile.model.ts";
import {
  Editor,
  PreviewBox,
  ProfileBody,
  Toolbar,
  typeInto,
} from "../src/web/views/Profile.tsx";

const NONE: ProfileAnswer = {
  text: null,
  html: null,
  revision: null,
  author: null,
  updated_at: null,
  bytes: null,
};

const MADE: ProfileAnswer = {
  text: "## Goals\n- Horizon: 5 years\n",
  html: '<h2 class="md-h2">Goals</h2><ul class="md-ul"><li class="md-li">Horizon: 5 years</li></ul>',
  revision: 3,
  author: "jordan-agent",
  updated_at: "2026-11-01T10:00:00Z",
  bytes: 28,
};

// answers by method and path; anything else fails the test
function answering(answers: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetch: Fetch = async (path, init) => {
    const key = `${init?.method ?? "GET"} ${path}`;
    asked.push(key);
    const answer = answers[key];
    if (answer === undefined) throw new Error(`no answer for ${key}`);
    return answer();
  };
  return {
    store: profileStore(
      client(fetch, () => {}),
      () => 0,
    ),
    asked,
  };
}

const problem = (status: number, code: string, detail: string) =>
  Response.json({ status, code, detail }, { status });

const saveButton = (html: string) =>
  /<button type="button" class="btn btn-primary"( disabled)?>Save<\/button>/.exec(
    html,
  );

describe("the Profile page", () => {
  test("with no profile offers to write one", async () => {
    const { store } = answering({
      [`GET ${PROFILE_PATH}`]: () => Response.json(NONE),
    });
    await store.load();
    const html = render(<ProfileBody store={store} />);
    expect(html).toContain("Write your profile");
    expect(html).toContain("Write it");
    expect(html).not.toContain("History");
    expect(html).not.toContain("Saved");
  });

  test("draws the server's HTML with who saved it, History and Edit", async () => {
    const { store } = answering({
      [`GET ${PROFILE_PATH}`]: () => Response.json(MADE),
    });
    await store.load();
    const html = render(<ProfileBody store={store} />);
    expect(html).toContain(MADE.html!);
    expect(html).toMatch(/Saved .+ by jordan-agent/);
    const { store: own } = answering({
      [`GET ${PROFILE_PATH}`]: () => Response.json({ ...MADE, author: "web" }),
    });
    await own.load();
    const mine = render(<ProfileBody store={own} />);
    expect(mine).toMatch(/Saved .+ by you/);
    expect(mine).not.toContain("by web");
    expect(html).toContain(">History</button>");
    expect(html).toContain("Edit</button>");
    expect(html).not.toContain("Write your profile");
  });

  test("a failed load says the page did not load, with a retry", async () => {
    const { store } = answering({
      [`GET ${PROFILE_PATH}`]: () =>
        problem(403, "forbidden", "this key has no profile access"),
    });
    expect(await store.load()).toBe(false);
    const html = render(<ProfileBody store={store} />);
    expect(html).toContain("This page did not load");
    expect(html).toContain("HTTP 403");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Write your profile");
  });
});

describe("the editor", () => {
  const { store } = answering({});

  test("Save waits on a change, but the outline saves as it is", () => {
    const same = render(
      <Editor
        store={store}
        start={MADE.text!}
        saved={MADE.text!}
        revision={3}
        onDone={() => {}}
      />,
    );
    expect(saveButton(same)?.[1]).toBe(" disabled");
    const outline = render(
      <Editor
        store={store}
        start={OUTLINE}
        saved=""
        revision={null}
        onDone={() => {}}
      />,
    );
    expect(saveButton(outline)).not.toBeNull();
    expect(saveButton(outline)?.[1]).toBeUndefined();
    expect(outline).toContain("## Goals");
  });

  test("counts the text's size against the cap, red past it", () => {
    const over = "x".repeat(MAX_BYTES + 1);
    const html = render(
      <Editor
        store={store}
        start={over}
        saved=""
        revision={1}
        onDone={() => {}}
      />,
    );
    expect(html).toContain('class="profile-size over"');
    expect(html).toContain("24.1 KB of 24.0 KB");
    const fits = render(
      <Editor
        store={store}
        start={OUTLINE}
        saved=""
        revision={null}
        onDone={() => {}}
      />,
    );
    expect(fits).toContain('class="profile-size"');
  });

  test("a stale save keeps the text and says what to do", async () => {
    const { store, asked } = answering({
      [`PUT ${PROFILE_PATH}`]: () =>
        Response.json(
          {
            status: 409,
            code: "conflict",
            detail: "profile is at revision 4",
            revision: 4,
          },
          { status: 409 },
        ),
    });
    expect(await store.save("## Goals\n- Changed\n", 3)).toBe(STALE);
    expect(STALE).toBe(
      "Changed since you opened it. Copy your text, then reload.",
    );
    // refused, so the profile is not read again over the typed text
    expect(asked).toEqual([`PUT ${PROFILE_PATH}`]);
  });

  test("any other refusal is the server's sentence", async () => {
    const { store } = answering({
      [`PUT ${PROFILE_PATH}`]: () =>
        problem(400, "bad_arguments", "text is empty"),
    });
    expect(await store.save(" ", 3)).toBe("Text is empty.");
  });

  test("a save reads the profile again", async () => {
    const { store, asked } = answering({
      [`PUT ${PROFILE_PATH}`]: () =>
        Response.json({ revision: 4, author: "web", bytes: 9 }),
      [`GET ${PROFILE_PATH}`]: () => Response.json({ ...MADE, revision: 4 }),
    });
    expect(await store.save("## Goals\n", 3)).toBeNull();
    expect(asked).toEqual([`PUT ${PROFILE_PATH}`, `GET ${PROFILE_PATH}`]);
    expect(store.profile.value?.revision).toBe(4);
  });
});

describe("the editor's model", () => {
  const at = (value: string, start: number, end = start): Picked => ({
    value,
    start,
    end,
  });
  const tool = (label: string) => TOOLS.flat().find((t) => t.label === label)!;

  test("wrap surrounds the selection and keeps it picked", () => {
    const p = at("buy the dip", 4, 7);
    const t = wrap(p, "**", "**", "bold");
    expect(typed(p.value, t)).toBe("buy **the** dip");
    expect(typed(p.value, t).slice(t.start, t.end)).toBe("the");
  });

  test("wrap with no selection types a placeholder, picked to type over", () => {
    const p = at("ab", 1);
    const t = tool("Link").run(p);
    const value = typed(p.value, t);
    expect(value).toBe("a[text](https://)b");
    expect(value.slice(t.start, t.end)).toBe("text");
  });

  test("lines marks the one line the cursor is on", () => {
    const p = at("one\ntwo\nthree", 5);
    const t = lines(p, "> ");
    const value = typed(p.value, t);
    expect(value).toBe("one\n> two\nthree");
    expect(value.slice(t.start, t.end)).toBe("> two");
  });

  test("lines marks every line the selection touches", () => {
    const p = at("one\ntwo\nthree", 1, 6);
    expect(typed(p.value, tool("Bulleted list").run(p))).toBe(
      "- one\n- two\nthree",
    );
    // a selection ending at a line's start leaves that line out
    const whole = at("one\ntwo\nthree", 0, 8);
    expect(typed(whole.value, tool("Heading").run(whole))).toBe(
      "## one\n## two\nthree",
    );
    // the first line, even when the text opens with an empty one
    const blank = at("\nnext", 0);
    expect(typed(blank.value, lines(blank, "- "))).toBe("- \nnext");
  });

  test("a numbered list counts from 1", () => {
    const p = at("a\nb\nc", 0, 5);
    const t = tool("Numbered list").run(p);
    const value = typed(p.value, t);
    expect(value).toBe("1. a\n2. b\n3. c");
    expect(value.slice(t.start, t.end)).toBe(value);
  });

  test("the size is UTF-8 bytes, shown in KB to one decimal", () => {
    expect(sizeOf("abc")).toBe(3);
    expect(sizeOf("€")).toBe(3);
    expect(kb(0)).toBe("0.0 KB");
    expect(kb(MAX_BYTES)).toBe("24.0 KB");
    expect(kb(1536)).toBe("1.5 KB");
    // rounded up, so a byte past the cap never reads as the cap
    expect(kb(MAX_BYTES + 1)).toBe("24.1 KB");
    expect(kb(1)).toBe("0.1 KB");
  });

  test("the owner's own saves read as you, an agent key by its name", () => {
    expect(authorWords("web")).toBe("you");
    expect(authorWords("admin")).toBe("you");
    expect(authorWords("jordan-agent")).toBe("jordan-agent");
  });

  test("the outline is the four sections, a hint line each", () => {
    expect(OUTLINE.match(/^## .+$/gm)).toEqual([
      "## Goals",
      "## Risk",
      "## Trading style",
      "## Analysis defaults",
    ]);
    expect(OUTLINE.match(/^- .+$/gm)).toHaveLength(4);
  });
});

describe("the history's restore", () => {
  test("a restore saves at the live revision and answers null, which closes the drawer", async () => {
    const { store, asked } = answering({
      [`PUT ${PROFILE_PATH}`]: () =>
        Response.json({ revision: 4, author: "web", bytes: 9 }),
      [`GET ${PROFILE_PATH}`]: () => Response.json({ ...MADE, revision: 4 }),
    });
    expect(await store.restore("## Goals\n", 3)).toBeNull();
    expect(asked).toEqual([`PUT ${PROFILE_PATH}`, `GET ${PROFILE_PATH}`]);
    expect(store.profile.value?.revision).toBe(4);
  });

  test("a stale restore reads the profile again and says to try again", async () => {
    const { store, asked } = answering({
      [`PUT ${PROFILE_PATH}`]: () =>
        problem(409, "conflict", "profile is at revision 5"),
      [`GET ${PROFILE_PATH}`]: () => Response.json({ ...MADE, revision: 5 }),
    });
    expect(await store.restore("## Goals\n", 3)).toBe(RESTORE_STALE);
    expect(asked).toEqual([`PUT ${PROFILE_PATH}`, `GET ${PROFILE_PATH}`]);
    // the drawer's live revision moves, so a second restore can land
    expect(store.profile.value?.revision).toBe(5);
  });
});

describe("the editor's preview", () => {
  test("shows a wait, a failure, an empty draft and the drawing apart", () => {
    expect(render(<PreviewBox drawn={null} />)).toContain("Drawing…");
    const failed = render(
      <PreviewBox drawn={{ failed: "The server did not answer." }} />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("The server did not answer.");
    expect(failed).not.toContain("Nothing to preview.");
    expect(render(<PreviewBox drawn={{ html: "" }} />)).toContain(
      "Nothing to preview.",
    );
    expect(render(<PreviewBox drawn={{ html: MADE.html! }} />)).toContain(
      MADE.html!,
    );
  });

  test("a preview asked before a tab switch or a close never lands", () => {
    const asked = latest();
    const first = asked.ask();
    // Write, then Preview again
    const second = asked.ask();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    // Cancel closes the editor
    asked.drop();
    expect(second()).toBe(false);
  });
});

describe("the profile after a sign-out", () => {
  test("a read in flight at sign-out never puts the profile back", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetch: Fetch = async (path, init) => {
      const key = `${init?.method ?? "GET"} ${path}`;
      if (key === `GET ${PROFILE_PATH}`) {
        await gate;
        return Response.json(MADE);
      }
      if (key === `DELETE ${SESSION_PATH}`) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`no answer for ${key}`);
    };
    const s = appStore(
      fetch,
      () => 0,
      () => "/profile",
      () => {},
    );
    const read = s.profile.load();
    await s.signOut();
    release();
    expect(await read).toBe(false);
    expect(s.profile.profile.value).toBeNull();
    expect(s.profile.error.value).toBeNull();
  });

  test("a 401 signs out and leaves no profile error behind", async () => {
    const fetch: Fetch = async () => problem(401, "unauthorized", "sign in");
    const s = appStore(
      fetch,
      () => 0,
      () => "/profile",
      () => {},
    );
    expect(await s.profile.load()).toBe(false);
    expect(s.signedIn.value).toBe(false);
    expect(s.profile.profile.value).toBeNull();
    expect(s.profile.error.value).toBeNull();
    expect(s.profile.code.value).toBeNull();
  });

  test("a save answered after a sign-out says nothing and reads nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const asked: string[] = [];
    const fetch: Fetch = async (path, init) => {
      const key = `${init?.method ?? "GET"} ${path}`;
      asked.push(key);
      if (key === `PUT ${PROFILE_PATH}`) {
        await gate;
        return problem(409, "conflict", "profile is at revision 4");
      }
      return new Response(null, { status: 204 });
    };
    const s = appStore(
      fetch,
      () => 0,
      () => "/profile",
      () => {},
    );
    const saving = s.profile.save("## Goals\n", 3);
    await s.signOut();
    release();
    expect(await saving).toBeNull();
    expect(asked).toEqual([`PUT ${PROFILE_PATH}`, `DELETE ${SESSION_PATH}`]);
  });
});

describe("the editor while it saves", () => {
  test("the toolbar is off", () => {
    const off = render(<Toolbar area={() => null} busy />);
    expect(off.match(/<button[^>]*disabled/g)).toHaveLength(8);
    const on = render(<Toolbar area={() => null} busy={false} />);
    expect(on).not.toContain("disabled");
  });

  test("a button types nothing into a read-only text box", () => {
    const touched: string[] = [];
    const area = {
      readOnly: true,
      focus: () => touched.push("focus"),
      setSelectionRange: () => touched.push("select"),
      setRangeText: () => touched.push("type"),
      dispatchEvent: () => touched.push("input"),
    } as unknown as HTMLTextAreaElement;
    typeInto(area, { from: 0, to: 0, text: "**bold**", start: 2, end: 6 });
    expect(touched).toEqual([]);
  });
});

describe("profile reads", () => {
  test("a later read supersedes one in flight that answers late", async () => {
    const held: (() => void)[] = [];
    let n = 0;
    const fetch: Fetch = async () => {
      const mine = ++n;
      await new Promise<void>((r) => held.push(r));
      return mine === 1
        ? problem(500, "internal", "failed")
        : Response.json({ ...MADE, revision: 4 });
    };
    const store = profileStore(
      client(fetch, () => {}),
      () => 0,
    );
    const first = store.load();
    const second = store.load();
    while (held.length < 2) await Bun.sleep(0);
    held[1]!();
    expect(await second).toBe(true);
    held[0]!();
    expect(await first).toBe(false);
    expect(store.profile.value?.revision).toBe(4);
    expect(store.error.value).toBeNull();
    expect(store.code.value).toBeNull();
  });
});
