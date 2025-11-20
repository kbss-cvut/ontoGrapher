import React from "react";
import { Dropdown, DropdownButton } from "react-bootstrap";
import { AppSettings } from "../../../config/Variables";
import { Locale } from "../../../config/Locale";
import { Environment } from "../../../config/Environment";

export default class MenuPanelLinks extends React.Component {
  render() {
    return (
      <DropdownButton id="links" title={Locale[AppSettings.interfaceLanguage].externalLinks} variant="primary">
          <Dropdown.Item
            href={
              Environment.components["al-issue-tracker"].meta["new-bug"]
            }
            eventKey="1"
            target={"_blank"}>
            {Locale[AppSettings.interfaceLanguage].reportIssue}
          </Dropdown.Item>
          <Dropdown.Item
            href={
              Environment.components["al-issue-tracker"].meta["new-feature"]
            }
            eventKey="2"
            target={"_blank"}
          >
            {Locale[AppSettings.interfaceLanguage].reportEnhancement}
          </Dropdown.Item>
          {Environment.components["al-termit"] && <Dropdown.Item
            href={
              Environment.components["al-termit"].url
            }
            eventKey="3"
          >
            {Locale[AppSettings.interfaceLanguage].toTermIt}
          </Dropdown.Item>}
      </DropdownButton>
    );
  }
}
