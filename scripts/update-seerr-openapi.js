import { updateOpenApi } from "./update-openapi.js";

await updateOpenApi({
  name: "SEERR",
  source: "https://raw.githubusercontent.com/seerr-team/seerr/develop/seerr-api.yml",
  filename: "seerr-openapi.yml",
  format: "YAML",
});
