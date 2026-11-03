import { Select } from "./Select"

export default { title: "Components/Select", component: Select }

const Template = (args: object) => <Select options={[]} getKey={() => ""} {...args} />

export const Basic = Template.bind({})
Basic.args = { options: ["a", "b"], getKey: (o: string) => o }
Basic.storyName = "Basic select"
