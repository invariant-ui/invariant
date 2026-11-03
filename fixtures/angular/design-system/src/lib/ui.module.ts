import { NgModule } from "@angular/core"
import { AcmeButton } from "./button.component"
import { AcmeCard } from "./card.component"
import { AcmeSpinner } from "./spinner.component"

@NgModule({ declarations: [AcmeCard], imports: [AcmeButton, AcmeSpinner], exports: [AcmeCard, AcmeButton] })
export class UiModule {}
