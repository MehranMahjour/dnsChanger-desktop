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

	private async getValidateInterface() {
        try {
            const interfaces: Interface[] = await this.getInterfacesList()
            
            // 1. Get all interfaces that actually have a gateway assigned
            const activeInterfaces = interfaces.filter(
                (inter: Interface) => inter.gateway_ip != null
            )

            if (activeInterfaces.length === 0) throw new Error('CONNECTION_FAILED')

            // 2. Filter out known virtual and VPN adapters
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

            // Fallback to activeInterfaces if physicalInterfaces is empty (prevents crashing)
            const validInterfaces = physicalInterfaces.length > 0 ? physicalInterfaces : activeInterfaces

            // 3. Prioritize Ethernet/Tethering over Wi-Fi if both have a ghost gateway
            const tetheringInterface = validInterfaces.find(
                (inter: Interface) => inter.name.toLowerCase().includes('ethernet')
            )

            // 4. Return Tethering first, otherwise fallback to whatever physical connection is left
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
