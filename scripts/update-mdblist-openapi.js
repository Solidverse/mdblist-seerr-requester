import { updateOpenApi } from "./update-openapi.js";

await updateOpenApi({
  name: "MDBLIST",
  source: "https://raw.githubusercontent.com/linaspurinis/api.mdblist.com/main/openapi.json",
  filename: "mdblist-openapi.json",
  format: "JSON",
});
