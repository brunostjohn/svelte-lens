import { mount } from "svelte";

import App from "./App.svelte";
import { ProductionModel } from "./Model.svelte.js";

mount(App, { target: document.querySelector("#app") });
globalThis.productionModel = new ProductionModel();
