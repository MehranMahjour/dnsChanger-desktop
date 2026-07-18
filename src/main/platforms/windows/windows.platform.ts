import * as os from 'node:os'
import { exec } from 'node:child_process'
import sudo from '@vscode/sudo-prompt'


import { store } from '../../store/store'
import { Platform } from '../platform'
import { Interface } from './interfaces/interface'

export class WindowsPlatform extends Platform {
	async clearDns(): Promise<void> {
		try {
			let networkInterface = store.get('settings').network_interface
			if (networkInterface === 'Auto')
				networkInterface = (await this.getValidateInterface()).name

			return new Promise((resolve, reject) => {
				sudo.exec(
					`netsh interface ip set dns "${networkInterface}" dhcp`,
					{
						name: 'DnsChanger',
					},
					(error) => {
						if (error) {
							reject(error)
							return
						}
						resolve()
					},
				)
			})
		} catch (e) {
			throw e
		}
	}

	async getActiveDns(): Promise<Array<string>> {
		try {
			let networkInterface = store.get('settings').network_interface
			if (networkInterface === 'Auto')
				networkInterface = (await this.getValidateInterface()).name

			const cmd = `netsh interface ip show dns "${networkInterface}"`
			const text = (await this.execCmd(cmd)) as string

			return this.extractDns(text)
		} catch (e) {
			throw e
		}
	}

	async getInterfacesList(): Promise<Interface[]> {
		const interfaces = os.networkInterfaces()
		const list: Interface[] = []

		for (const [name, addrs] of Object.entries(interfaces)) {
			const ipv4 = addrs.find((a) => a.family === 'IPv4' && !a.internal)
			if (ipv4) {
				list.push({
					name: name,
					mac_address: ipv4.mac,
					ip_address: ipv4.address,
					netmask: ipv4.netmask,
					type: name.toLowerCase().includes('wi-fi') ? 'Wireless' : 'Wired',
					vendor: 'Unknown',
					model: 'Unknown',
					gateway_ip: null,
				})
			}
		}

		try {
			const gatewayInfo = await this.getGateways()
			for (const inter of list) {
				inter.gateway_ip = gatewayInfo[inter.name] || null
			}
		} catch (e) {
			// fallback if netsh fails
		}

		return list
	}

	private getGateways(): Promise<Record<string, string>> {
		return new Promise((resolve) => {
			exec('netsh interface ip show config', (error, stdout) => {
				if (error) {
					resolve({})
					return
				}

				const gateways: Record<string, string> = {}
				const sections = stdout.split(/\r?\n\r?\n/)
				for (const section of sections) {
					const nameMatch = section.match(/Configuration for interface "(.+)"/)
					if (nameMatch) {
						const name = nameMatch[1]
						const gatewayMatch = section.match(/[Gg]ateway.*:\s+([\d.]+)/)
						if (gatewayMatch) {
							gateways[name] = gatewayMatch[1]
						}
					}
				}
				resolve(gateways)
			})
		})
	}

	async setDns(nameServers: Array<string>): Promise<void> {
		try {
			let networkInterface = store.get('settings').network_interface
			if (networkInterface === 'Auto')
				networkInterface = (await this.getValidateInterface()).name
			const cmdServer1 = `netsh interface ip set dns "${networkInterface}" static ${nameServers[0]}`

			await this.execCmd(cmdServer1)

			if (nameServers[1]) {
				const cmdServer2 = `netsh interface ip add dns "${networkInterface}" ${nameServers[1]} index=2`
				await this.execCmd(cmdServer2)
			}
		} catch (e) {
			throw e
		}
	}

	private async getDefaultRouteInterfaceName(): Promise<string | null> {
	try {
		// 1. Build a map of interface index -> interface name
		const ifaceOutput = (await this.execCmd(
			'netsh interface ipv4 show interfaces',
		)) as string

		const idxToName: Record<string, string> = {}
		const ifaceLineRegex = /^\s*(\d+)\s+\d+\s+\d+\s+\S+\s+(.+?)\s*$/gm
		let ifaceMatch: RegExpExecArray | null
		while ((ifaceMatch = ifaceLineRegex.exec(ifaceOutput)) !== null) {
			const [, idx, name] = ifaceMatch
			idxToName[idx] = name
		}

		// 2. Find the 0.0.0.0/0 route(s) and pick the lowest metric (Windows' actual preference)
		const routeOutput = (await this.execCmd(
			'netsh interface ipv4 show route',
		)) as string

		let bestMetric = Infinity
		let bestIdx: string | null = null
		const routeLineRegex = /^\S+\s+\S+\s+(\d+)\s+0\.0\.0\.0\/0\s+(\d+)\s+/gm
		let routeMatch: RegExpExecArray | null
		while ((routeMatch = routeLineRegex.exec(routeOutput)) !== null) {
			const [, metricStr, idx] = routeMatch
			const metric = parseInt(metricStr, 10)
			if (metric < bestMetric) {
				bestMetric = metric
				bestIdx = idx
			}
		}

		if (bestIdx && idxToName[bestIdx]) {
			return idxToName[bestIdx]
		}
		return null
	} catch {
		return null
	}
}

private async getValidateInterface() {
	try {
		const interfaces: Interface[] = await this.getInterfacesList()

		// 0. Ask Windows directly which interface owns the default route.
		// This is authoritative and doesn't depend on "show config" printing
		// a Gateway line, which tethered adapters often skip.
		const defaultRouteName = await this.getDefaultRouteInterfaceName()
		if (defaultRouteName) {
			const matched = interfaces.find(
				(inter) => inter.name === defaultRouteName,
			)
			if (matched) return matched
		}

		// 1. Fallback: previous heuristic based on gateway_ip presence
		const activeInterfaces = interfaces.filter(
			(inter: Interface) => inter.gateway_ip != null,
		)

		if (activeInterfaces.length === 0) throw new Error('CONNECTION_FAILED')

		const physicalInterfaces = activeInterfaces.filter((inter: Interface) => {
			const lowerName = inter.name.toLowerCase()
			return (
				!lowerName.includes('vmware') &&
				!lowerName.includes('virtual') &&
				!lowerName.includes('vethernet') &&
				!lowerName.includes('wsl') &&
				!lowerName.includes('loopback') &&
				!lowerName.includes('vpn') &&
				!lowerName.includes('tun')
			)
		})

		const validInterfaces =
			physicalInterfaces.length > 0 ? physicalInterfaces : activeInterfaces

		const tetheringInterface = validInterfaces.find((inter: Interface) =>
			inter.name.toLowerCase().includes('ethernet'),
		)

		return tetheringInterface || validInterfaces[0]
	} catch (error) {
		throw error
	}
}

	private extractDns(input: string): Array<string> {
		const regex = /Statically Configured DNS Servers:\s+([\d.]+)\s+([\d.]+)/gm
		const matches = regex.exec(input) || []
		if (!matches.length) return []
		return [matches[1].trim(), matches[2].trim()]
	}

	public async flushDns(): Promise<void> {
		return new Promise((resolve, reject) => {
			sudo.exec(
				'ipconfig /flushdns',
				{
					name: 'DnsChanger',
				},
				(error) => {
					if (error) {
						reject(error)
						return
					}
					resolve()
				},
			)
		})
	}
}
