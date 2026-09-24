import {
  DarkThemeIcon,
  LightThemeIcon,
  SystemThemeIcon,
  type IconComponent,
} from '../components/icons'
import { Button } from '../components/ui/Button'
import { Menu, MenuLabel, MenuRadioGroup, MenuRadioItem } from '../components/ui/Menu'
import { useTheme, type ThemePreference } from '../hooks/useTheme'

const options: { value: ThemePreference; label: string; icon: IconComponent }[] = [
  { value: 'light', label: 'Light', icon: LightThemeIcon },
  { value: 'dark', label: 'Dark', icon: DarkThemeIcon },
  { value: 'system', label: 'System', icon: SystemThemeIcon },
]

/**
 * Light, dark, or follow the system. The trigger shows the theme in effect
 * rather than the stored choice, so "System" on a dark machine reads as dark.
 */
export function ThemeMenu() {
  const { preference, resolved, setPreference } = useTheme()
  const TriggerIcon = resolved === 'dark' ? DarkThemeIcon : LightThemeIcon

  return (
    <Menu
      trigger={
        <Button variant="ghost" iconOnly aria-label="Theme" title="Theme" className="theme-menu">
          <TriggerIcon />
        </Button>
      }
    >
      <MenuLabel>Theme</MenuLabel>
      <MenuRadioGroup label="Theme" value={preference} onValueChange={setPreference}>
        {options.map(({ value, label, icon: Icon }) => (
          <MenuRadioItem key={value} value={value} icon={<Icon />}>
            {label}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </Menu>
  )
}
