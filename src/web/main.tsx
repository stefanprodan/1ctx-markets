// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import "./style/tokens.css";
import "./style/base.css";
import { render } from "preact";
import { App } from "./app/App.tsx";
import { boot } from "./app/router.ts";
import { watchScreen } from "./app/shell.ts";
import { watchTheme } from "./app/theme.ts";
import { watchTitle } from "./app/title.ts";

watchTheme();
boot();
watchScreen();
watchTitle();
render(<App />, document.getElementById("app")!);
