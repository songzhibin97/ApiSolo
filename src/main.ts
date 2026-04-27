import { createApp } from "vue"

import App from "./App.vue"
import "./assets/main.css"
import i18n from "./i18n"
import router from "./router"
import pinia from "./stores"
import { initializeConsoleInterceptors, recordConsoleEntry } from "./stores/console"

const app = createApp(App)

app.use(pinia).use(router).use(i18n)

initializeConsoleInterceptors()
recordConsoleEntry("info", "App initialized", "app")

app.mount("#app")
