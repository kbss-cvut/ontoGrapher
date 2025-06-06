import isUrl from "is-url";
import * as _ from "lodash";
import { Alert } from "react-bootstrap";
import TableList from "../components/TableList";
import { callCriticalAlert } from "../config/CriticalAlertData";
import { MainViewMode } from "../config/Enum";
import { Environment } from "../config/Environment";
import { Locale } from "../config/Locale";
import { StoreSettings } from "../config/Store";
import {
  AppSettings,
  Diagrams,
  Languages,
  Links,
  WorkspaceElements,
  WorkspaceLinks,
  WorkspaceTerms,
  WorkspaceVocabularies,
} from "../config/Variables";
import { CacheSearchVocabularies } from "../datatypes/CacheSearchResults";
import { insertNewCacheTerms } from "../function/FunctionCache";
import { addToFlexSearch } from "../function/FunctionCreateVars";
import {
  deleteConcept,
  initElements,
  parsePrefix,
} from "../function/FunctionEditVars";
import {
  isElementHidden,
  removeReadOnlyElement,
} from "../function/FunctionElem";
import { isTermReadOnly } from "../function/FunctionGetVars";
import { initConnections } from "../function/FunctionRestriction";
import { qb } from "../queries/QueryBuilder";
import {
  fetchReadOnlyTerms,
  fetchVocabularies,
} from "../queries/get/CacheQueries";
import {
  fetchRestrictions,
  fetchTerms,
  fetchUsers,
  fetchVocabulary,
} from "../queries/get/FetchQueries";
import {
  getElementsConfig,
  getLinksConfig,
  getSettings,
} from "../queries/get/InitQueries";
import { updateDeleteDiagram } from "../queries/update/UpdateDiagramQueries";
import { updateProjectElement } from "../queries/update/UpdateElementQueries";
import { updateProjectLinkParallel } from "../queries/update/UpdateLinkQueries";
import { fetchUserSettings } from "../queries/update/UpdateMiscQueries";
import { processQuery, processTransaction } from "./TransactionInterface";

export function retrieveInfoFromURLParameters(): boolean {
  if (!(Environment.language in Languages))
    throw new Error(
      "TERM_LANGUAGE environment variable is not listed in the Languages.ts object."
    );
  const isURL = require("is-url");
  const urlParams = new URLSearchParams(window.location.search);
  const URIContexts = urlParams.getAll("vocabulary");
  if (URIContexts.filter((context) => isURL(context)).length > 0) {
    for (const vocab of URIContexts)
      AppSettings.contextIRIs.push(decodeURIComponent(vocab));
    return true;
  } else {
    console.error("Unable to parse vocabulary IRI(s) from the URL.");
    return false;
  }
}

export async function updateContexts(): Promise<boolean> {
  const ret1 = await getSettings(AppSettings.contextEndpoint);
  const ret2 = await fetchUsers(
    ...Object.values(Diagrams).flatMap((d) => d.collaborators)
  );
  if (Environment.auth) await fetchUserSettings();
  AppSettings.selectedDiagram = "";
  StoreSettings.update((s) => {
    s.selectedDiagram = AppSettings.selectedDiagram;
  });
  return ret1 && ret2;
}

//TODO: hot
export async function retrieveVocabularyData(): Promise<boolean> {
  await fetchVocabularies(
    AppSettings.contextEndpoint,
    AppSettings.cacheContext
  );
  const vocabularyQ = [
    "PREFIX owl: <http://www.w3.org/2002/07/owl#> ",
    "PREFIX skos: <http://www.w3.org/2004/02/skos/core#> ",
    "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> ",
    "PREFIX termit: <http://onto.fel.cvut.cz/ontologies/application/termit/>",
    "PREFIX a-popis-dat-pojem: <http://onto.fel.cvut.cz/ontologies/slovník/agendový/popis-dat/pojem/>",
    "PREFIX dcterms: <http://purl.org/dc/terms/>",
    "select ?contextIRI ?scheme ?vocabLabel ?vocabIRI ?changeContext",
    "where {",
    "graph ?contextIRI {",
    `OPTIONAL { ?vocabulary <${parsePrefix(
      "d-sgov-pracovní-prostor-pojem",
      "má-kontext-sledování-změn"
    )}> ?changeContext. }`,
    "?vocabIRI a a-popis-dat-pojem:slovník .",
    "?vocabIRI a-popis-dat-pojem:má-glosář ?scheme.",
    "?vocabIRI dcterms:title ?vocabLabel .",
    "}",
    `values ?contextIRI {<${AppSettings.contextIRIs.join("> <")}>}`,
    "}",
  ].join(`
  `);
  const vocabularies: {
    [key: string]: {
      names: { [key: string]: string };
      terms: typeof WorkspaceTerms;
      graph: string;
      glossary: string;
      changeContext?: string;
    };
  } = {};
  const responseInit: boolean = await processQuery(
    AppSettings.contextEndpoint,
    vocabularyQ
  )
    .then((response) => response.json())
    .then((data) => {
      if (data.results.bindings.length === 0) return false;
      for (const result of data.results.bindings) {
        if (!(result.vocabIRI.value in vocabularies)) {
          vocabularies[result.vocabIRI.value] = {
            names: {},
            terms: {},
            graph: result.contextIRI.value,
            glossary: result.scheme.value,
          };
        }
        if (result.changeContext)
          vocabularies[result.vocabIRI.value].changeContext =
            result.changeContext.value;
        vocabularies[result.vocabIRI.value].names[
          result.vocabLabel["xml:lang"]
        ] = result.vocabLabel.value;
      }
      return true;
    })
    .catch(() => false);
  if (!responseInit) return false;
  await fetchVocabulary(
    Object.keys(vocabularies).map((vocab) => vocabularies[vocab].glossary),
    false,
    AppSettings.contextEndpoint
  ).catch(() => false);
  for (const vocab in vocabularies) {
    Object.assign(
      WorkspaceTerms,
      await fetchTerms(
        AppSettings.contextEndpoint,
        vocabularies[vocab].glossary,
        vocab,
        vocabularies[vocab].graph
      )
    );
    Object.assign(
      WorkspaceTerms,
      _.merge(
        WorkspaceTerms,
        await fetchRestrictions(
          AppSettings.contextEndpoint,
          WorkspaceTerms,
          vocabularies[vocab].glossary,
          vocab,
          vocabularies[vocab].graph
        )
      )
    );
    WorkspaceVocabularies[vocab].readOnly = false;
    WorkspaceVocabularies[vocab].graph = vocabularies[vocab].graph;
    if (vocabularies[vocab].changeContext)
      WorkspaceVocabularies[vocab].changeContext =
        vocabularies[vocab].changeContext;
    Object.assign(WorkspaceTerms, vocabularies[vocab].terms);
  }
  const numberOfVocabularies = Object.keys(vocabularies).length;
  if (numberOfVocabularies === 1)
    AppSettings.name = Object.values(vocabularies)[0].names;
  else {
    for (const lang in AppSettings.name)
      AppSettings.name[lang] = `${Object.keys(vocabularies).length} ${
        Locale[AppSettings.interfaceLanguage][
          numberOfVocabularies >= 5
            ? "vocabulariesMorePlural"
            : "vocabulariesPlural"
        ]
      }`;
  }
  return true;
}

//TODO: hot
export async function retrieveContextData(): Promise<boolean> {
  const configs = await Promise.all([getElementsConfig(), getLinksConfig()]);
  if (configs.some((c) => !c)) return false;
  Object.keys(WorkspaceLinks).forEach((l) => {
    if (
      WorkspaceLinks[l].source in WorkspaceElements &&
      WorkspaceLinks[l].target in WorkspaceElements
    ) {
      WorkspaceElements[WorkspaceLinks[l].source].sourceLinks.push(l);
      WorkspaceElements[WorkspaceLinks[l].target].targetLinks.push(l);
    }
  });
  const missingTerms: string[] = Object.keys(WorkspaceElements).filter(
    (id) => !(id in WorkspaceTerms)
  );
  const readOnlyTerms = await fetchReadOnlyTerms(
    AppSettings.contextEndpoint,
    missingTerms
  );
  insertNewCacheTerms(readOnlyTerms);
  const readOnlyTermsTropes = Object.values(readOnlyTerms)
    .flatMap((t) => t.restrictions)
    .filter(
      (r) =>
        r.onProperty === parsePrefix("z-sgov-pojem", "má-vlastnost") &&
        isUrl(r.target) &&
        !(r.target in WorkspaceTerms)
    )
    .map((r) => r.target);
  if (readOnlyTermsTropes.length > 0) {
    insertNewCacheTerms(
      await fetchReadOnlyTerms(AppSettings.contextEndpoint, readOnlyTermsTropes)
    );
  }
  Object.keys(WorkspaceLinks)
    .filter((id) => {
      const iri = WorkspaceLinks[id].iri;
      return !(iri in WorkspaceTerms) && !(iri in Links);
    })
    .forEach((id) => {
      const iri = WorkspaceLinks[id].iri;
      // In all probability, the workspace has been modified outside of OG
      // *OR* OG deletes its terms (i.e. relationship types) incorrectly.
      console.warn(
        `Link ID ${id}'s type (${iri}) not found in vocabulary contexts nor cache contexts.`
      );
      WorkspaceLinks[id].active = false;
      if (iri in WorkspaceTerms) deleteConcept(iri);
    });
  Object.keys(WorkspaceElements)
    .filter((id) => !(id in WorkspaceTerms))
    .forEach((id) => {
      // In all probability, the workspace has been modified outside of OG
      // *OR* OG deletes its terms incorrectly.
      console.warn(
        `Term ${id} not found in vocabulary contexts nor cache contexts.`
      );
      deleteConcept(id);
    });
  const elements = initElements();
  if (
    !(await processTransaction(
      AppSettings.contextEndpoint,
      qb.constructQuery(updateProjectElement(false, ...elements))
    ))
  )
    return false;
  addToFlexSearch(...Object.keys(WorkspaceElements));
  const connections = initConnections();
  for (const id of connections.del) {
    // This is expected behavior e.g. for imported diagrams,
    // if they have references to links that no longer exist in the data.
    console.warn(
      `del: Link ID ${id} ( ${WorkspaceLinks[id].source} -- ${WorkspaceLinks[id].iri} -> ${WorkspaceLinks[id].target} ) deactivated due to its statement counterpart(s) missing.`
    );
    if (
      WorkspaceLinks[id].iri === parsePrefix("z-sgov-pojem", "je-vlastností") &&
      WorkspaceLinks[id].source in WorkspaceElements &&
      WorkspaceElements[WorkspaceLinks[id].source].vocabulary !== undefined &&
      WorkspaceElements[WorkspaceLinks[id].source].vocabulary! in
        WorkspaceVocabularies &&
      WorkspaceVocabularies[
        WorkspaceElements[WorkspaceLinks[id].source].vocabulary!
      ].readOnly
    ) {
      continue;
    }

    if (
      WorkspaceLinks[id].iri === parsePrefix("z-sgov-pojem", "má-vlastnost") &&
      WorkspaceLinks[id].target in WorkspaceElements &&
      WorkspaceElements[WorkspaceLinks[id].target].vocabulary !== undefined &&
      WorkspaceElements[WorkspaceLinks[id].target].vocabulary! in
        WorkspaceVocabularies &&
      WorkspaceVocabularies[
        WorkspaceElements[WorkspaceLinks[id].target].vocabulary!
      ].readOnly
    ) {
      continue;
    }
    WorkspaceLinks[id].active = false;
    // Really poorly thought out hack!
    if (
      WorkspaceLinks[id].iri ===
        parsePrefix("z-sgov-pojem", "má-vztažený-prvek-1") ||
      WorkspaceLinks[id].iri ===
        parsePrefix("z-sgov-pojem", "má-vztažený-prvek-2")
    ) {
      const relElem = WorkspaceLinks[id].source;
      const relLink = Object.keys(WorkspaceLinks).find(
        (id) => WorkspaceLinks[id].iri === relElem
      );
      if (relLink) {
        console.warn(
          `rel: Link ID ${relLink} ( ${WorkspaceLinks[relLink].source} -- ${WorkspaceLinks[relLink].iri} -> ${WorkspaceLinks[relLink].target} ) deactivated due to its statement counterpart(s) missing.`
        );
        WorkspaceLinks[relLink].active = false;
      }
    }
  }
  return await processTransaction(
    AppSettings.contextEndpoint,
    ...updateProjectLinkParallel(...connections.add).map((t) =>
      qb.constructQuery(t)
    )
  );
}

export function checkForObsoleteDiagrams() {
  const diagramsInCache = Object.keys(CacheSearchVocabularies).flatMap(
    (vocab) => CacheSearchVocabularies[vocab].diagrams
  );
  const diagramsWithVocabularies = Object.keys(CacheSearchVocabularies)
    .filter(
      (vocab) =>
        vocab in WorkspaceVocabularies && !WorkspaceVocabularies[vocab].readOnly
    )
    .flatMap((vocab) => CacheSearchVocabularies[vocab].diagrams);
  // Diagrams that
  // ( are in cache
  // *but* are not associated with write-enabled vocabularies present in the workspace )
  const diff = _.difference(diagramsInCache, diagramsWithVocabularies);
  const workspaceDiagrams = Object.values(Diagrams).map((diag) => diag.iri);
  // *and* are in the workspace
  // are to be deleted
  const diagrams = _.intersection(diff, workspaceDiagrams);
  if (diagrams.length > 0) {
    const diagramsToDelete = Object.keys(Diagrams).filter((diag) =>
      diagrams.includes(Diagrams[diag].iri)
    );
    callCriticalAlert({
      acceptFunction: async () => {
        const queries: string[] = [];
        queries.push(
          ...Object.keys(WorkspaceElements)
            .filter(
              (term) =>
                isTermReadOnly(term) &&
                Object.keys(WorkspaceElements[term].hidden).every(
                  (diag) =>
                    isElementHidden(term, diag) ||
                    diagramsToDelete.includes(diag)
                )
            )
            .flatMap((elem) => removeReadOnlyElement(elem))
        );
        for (const diag of diagramsToDelete) {
          Diagrams[diag].toBeDeleted = true;
          queries.push(updateDeleteDiagram(diag));
        }
        AppSettings.selectedDiagram = "";
        StoreSettings.update((s) => {
          s.mainViewMode = MainViewMode.CANVAS;
          s.selectedDiagram = "";
        });
        await processTransaction(
          AppSettings.contextEndpoint,
          qb.constructQuery(...queries)
        );
      },
      acceptLabel:
        Locale[AppSettings.interfaceLanguage]
          .obsoleteDiagramsAlertDeleteDiagrams,
      waitForFunctionBeforeModalClose: true,
      innerContent: (
        <div>
          <p>
            {Locale[AppSettings.interfaceLanguage].obsoleteDiagramsAlertIntro}
          </p>
          <TableList>
            {diagramsToDelete.map((diag) => (
              <tr key={diag}>
                <td key={diag}>{Diagrams[diag].name}</td>
              </tr>
            ))}
          </TableList>
          <Alert variant={"warning"}>
            {Locale[AppSettings.interfaceLanguage].obsoleteDiagramsAlertInfo}
          </Alert>
        </div>
      ),
    });
  }
}
